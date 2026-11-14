export const isHumanRequest = r => Boolean(r && (r.audience === 'human' || (r.audience === 'route-repair' && (r.forwarded || r.routeReason === 'no-queen'))));

export function needsHuman(r) {
  return isHumanRequest(r) && (r.state === 'open' || (r.state === 'answered' && r.delivery?.state !== 'delivered'));
}
