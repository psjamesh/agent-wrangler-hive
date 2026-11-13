function prose(text) {
  let fence = null;
  const lines = String(text || '').split('\n').map(line => {
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return '';
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      return '';
    }
    return line;
  });
  return lines.join('\n').replace(/(?<![\\`])(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
}

const REFERENCE = /(?<![A-Za-z0-9_.-])hive-[a-z0-9]+(?:[.-][a-z0-9]+)*(?![A-Za-z0-9_-]|\.[A-Za-z0-9_])/g;

export function beadReferenceMatches(text) {
  return String(text || '').matchAll(REFERENCE);
}

export function beadReferences(text) {
  return [...new Set([...beadReferenceMatches(prose(text))].map(match => match[0]))];
}
