import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const walk = el => el && typeof el === 'object' ? [el, ...el.children.flatMap(walk)] : [];
const source = fs.readFileSync(new URL('../public/codex-approvals.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
const draw = vm.runInNewContext(source + '\ncodexApprovalsForm', { h });

for (const value of [undefined, 'config', 'approve-for-me', 'on-request', 'never']) {
  test(`Codex approvals form selects ${value ?? 'default'}, saves and reports outcomes`, () => {
    const forms = new Map(), sent = [];
    const ctx = { ui: { form: k => forms.get(k), setForm: (k, v) => forms.set(k, v), patchForm: (k, v) => forms.set(k, { ...forms.get(k), ...v }) }, send: (msg, options) => sent.push({ msg, options }) };
    const cell = { id: 'one', codexApprovals: value };
    let tree = draw(ctx, cell);
    const options = walk(tree).filter(el => el.tag === 'option');
    assert.deepEqual(Array.from(options, el => el.children[0]), ['Use my Codex config', 'Approve for me', 'Ask me', 'Never ask']);
    assert.equal(options.find(el => el.attrs.selected).attrs.value, value ?? 'config');
    walk(tree).find(el => el.tag === 'select').attrs.onchange({ target: { value: 'approve-for-me' } });
    tree = draw(ctx, cell);
    tree.attrs.onsubmit({ preventDefault() {} });
    tree.attrs.onsubmit({ preventDefault() {} });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.type, 'hive-codex-approvals');
    assert.equal(sent[0].msg.cellId, 'one');
    assert.equal(sent[0].msg.value, 'approve-for-me');
    assert.equal(walk(draw(ctx, cell)).find(el => el.tag === 'select').attrs.disabled, true);
    sent[0].options.onReply({ ok: false, error: 'Save failed' });
    assert.ok(walk(draw(ctx, cell)).some(el => el.children.includes('Save failed')));
    draw(ctx, cell).attrs.onsubmit({ preventDefault() {} });
    sent[1].options.onReply({ ok: true });
    assert.ok(walk(draw(ctx, cell)).some(el => el.children.includes('Codex approvals saved.')));
    assert.equal(walk(draw(ctx, { id: 'two' })).find(el => el.tag === 'option' && el.attrs.selected).attrs.value, 'config');
  });
}
