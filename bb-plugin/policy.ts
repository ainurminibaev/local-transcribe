export function candidates(services, primary, fallback, selfHostId) {
  const resolve = (name) => {
    if (name === 'self') return selfHostId;
    if (name === 'mac') return services.find(s => s.platform === 'Darwin' || /mac/i.test(s.name))?.hostId;
    if (name === 'auto') return [...services].filter(s => s.ready).sort((a,b) => score(b) - score(a))[0]?.hostId;
    return services.find(s => s.hostId === name || s.name === name)?.hostId;
  };
  const result = [];
  for (const name of [primary, ...fallback]) {
    if (name === 'available') {
      for (const service of [...services].filter(s => s.ready).sort((a,b) => score(b) - score(a))) {
        if (!result.includes(service.hostId)) result.push(service.hostId);
      }
      continue;
    }
    const id = resolve(name);
    if (id && !result.includes(id)) result.push(id);
  }
  return result;
}
function score(s) { return s.device === 'mps' ? 3 : s.device === 'cuda' ? 2 : 1; }
