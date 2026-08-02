import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateExecutiveBrief } from '../lib/executive/generator.mjs';

const data = {
  meta: { timestamp: '2026-08-02T12:00:00.000Z', sourcesOk: 28, sourcesQueried: 29 },
  news: [{ title: 'Major verified event', source: 'Wire', url: 'https://example.com/event', date: '2026-08-02T11:59:00Z' }],
};
const delta = { summary: { totalChanges: 1, criticalChanges: 1, direction: 'risk-off', signalBreakdown: { new: 1, escalated: 0, deescalated: 0, unchanged: 2 } }, signals: { new: [], escalated: [], deescalated: [], unchanged: [] } };

describe('generateExecutiveBrief', () => {
  it('produces bilingual structured output with resolved evidence', async () => {
    let calls = 0;
    const prompts = [];
    const provider = {
      name: 'mock', model: 'mock-model',
      async complete(systemPrompt) {
        calls += 1;
        prompts.push(systemPrompt);
        const id = systemPrompt.match(/\[(E\d+)\]/)?.[1];
        const ar = calls === 2;
        return { text: JSON.stringify({
          title: ar ? 'الإحاطة التنفيذية' : 'Executive Brief',
          riskLevel: 'HIGH', summary: ar ? `تغير مادي مهم وموثق في المشهد الحالي [${id}]` : `Major verified event [${id}]`,
          developments: [{ title: ar ? 'تطور مهم' : 'Event', whyItMatters: ar ? 'له أثر مباشر على القرار' : 'Impact', businessImpact: ar ? 'مخاطر على الأعمال' : 'Risk', action: ar ? 'المراقبة والتحقق المستمر' : 'Monitor', confidence: 'HIGH', citations: [id] }],
          actions: [ar ? 'المراقبة والتحقق المستمر' : 'Monitor'], uncertainties: [ar ? 'لا يزال التحقق مستمرا' : 'Verification'],
        }), usage: { inputTokens: 10, outputTokens: 5 }, model: 'mock-model' };
      },
    };
    const result = await generateExecutiveBrief(provider, data, delta);
    assert.equal(calls, 2);
    assert.equal(result.en.title, 'Executive Brief');
    assert.equal(result.ar.title, 'الإحاطة التنفيذية');
    assert.equal(result.en.evidence[0].url, 'https://example.com/event');
    assert.deepEqual(result.en.developments[0].citations, [result.en.evidence[0].id]);
    assert.doesNotMatch(result.en.summary, /\[UNSUPPORTED\]/);
    assert.deepEqual(result.tokenUsage, { inputTokens: 20, outputTokens: 10 });
    assert.match(prompts[1], /Translate text values only/);
    assert.match(prompts[1], /Executive Brief/);
    assert.equal(result.en.riskLevel, result.ar.riskLevel);
    assert.deepEqual(result.en.developments.map(item => item.citations), result.ar.developments.map(item => item.citations));
  });

  it('fails closed when Arabic changes the canonical risk, order, or evidence mapping', async () => {
    let calls = 0;
    const provider = { name: 'mock', model: 'mock', async complete(systemPrompt) {
      calls += 1;
      const id = systemPrompt.match(/\[(E\d+)\]/)?.[1];
      return { text: JSON.stringify({
        title: calls === 1 ? 'Canonical brief' : 'الإحاطة العربية',
        riskLevel: calls === 1 ? 'HIGH' : 'LOW',
        summary: calls === 1 ? `Major verified event [${id}]` : `تطور مهم موثق في المشهد الحالي [${id}]`,
        developments: [{ title: calls === 1 ? 'Event' : 'تطور مهم', whyItMatters: calls === 1 ? 'Direct business impact' : 'أثر مباشر على الأعمال', businessImpact: calls === 1 ? 'Material operating risk' : 'مخاطر تشغيلية جوهرية', action: calls === 1 ? 'Monitor verified signals' : 'راقب الإشارات الموثقة', confidence: 'HIGH', citations: [id] }],
        actions: [calls === 1 ? 'Monitor verified signals' : 'راقب الإشارات الموثقة'],
        uncertainties: [calls === 1 ? 'Verification remains incomplete' : 'لا يزال التحقق غير مكتمل'],
      }) };
    } };
    await assert.rejects(generateExecutiveBrief(provider, data, delta), /bilingual alignment failed: risk level/);
  });

  it('rejects invalid risk levels and non-Arabic output', async () => {
    const provider = { name: 'mock', model: 'mock', async complete(systemPrompt) {
      const id = systemPrompt.match(/\[(E\d+)\]/)?.[1];
      return { text: JSON.stringify({ title: 'English only', riskLevel: 'NONSENSE', summary: `Fact [${id}]`, developments: [{ title: 'Event', whyItMatters: 'Impact', businessImpact: 'Risk', action: 'Monitor', confidence: 'HIGH', citations: [id] }], actions: [], uncertainties: [] }) };
    } };
    await assert.rejects(generateExecutiveBrief(provider, data, delta), /risk level|Arabic/);
  });
});
