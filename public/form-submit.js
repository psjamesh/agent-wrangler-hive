const stamp = () => Date.now().toString(36);

export function submitForm({ ctx, key, allow, invalid, newId = stamp, message, failed, lateFailure, succeeded }) {
  const { ui, send } = ctx;
  const cur = ui.form(key);
  if (!cur || cur.pending || (allow && !allow(cur))) return;
  const error = invalid?.(cur);
  if (error) {
    ui.setForm(key, { ...cur, error });
    return;
  }
  const id = newId(cur);
  ui.setForm(key, { ...cur, pending: id, error: null });
  send(message(cur), {
    onReply: (frame) => {
      const mine = ui.form(key)?.pending === id;
      if (!frame.ok) {
        if (mine) ui.setForm(key, { ...ui.form(key), pending: null, error: frame.error || failed });
        else lateFailure(frame);
        return;
      }
      succeeded(frame, mine);
    },
  });
}
