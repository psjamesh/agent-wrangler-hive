export const isHumanRequest = r => Boolean(r && (r.audience === 'human' || (r.audience === 'route-repair' && (r.forwarded || r.routeReason === 'no-queen'))));

export function needsHuman(r) {
  return isHumanRequest(r) && (r.state === 'open' || (r.state === 'answered' && r.delivery?.state !== 'delivered'));
}

export function requestSubjectText(r) {
  const pin = r.answer?.subjectPin || r.subjectPin;
  if (!pin) return '';
  const prefix = r.answer ? r.answer.author === 'human' ? 'Human answer was for' : 'Queen answer was for' : 'Requested version';
  const current = r.subjectObservation?.revision;
  return `${prefix} ${pin.revision}${current && current !== pin.revision ? `, now ${current}` : ''}`;
}

export function requestDisplay(r) {
  const rewritten = Boolean(r.forwarded?.title || r.forwarded?.body);
  return { title: r.forwarded?.title || r.title, body: r.forwarded?.body || r.body, rewritten };
}
