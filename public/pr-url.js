export function canonicalPrUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/i);
  return match ? `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${match[3]}` : null;
}

