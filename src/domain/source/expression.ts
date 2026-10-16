/** A C expression grammar with no calls, assignment, increment, comma or casts.
 * GDB also disables function calls. The whitelist is independent of MI quoting. */
export function isSafeCExpression(expression: string): boolean {
  if (!expression || expression.length > 512 || /[\r\n\0]/.test(expression)) return false;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    const match =
      /^\s*(->|<<|>>|<=|>=|==|!=|&&|\|\||[A-Za-z_$][A-Za-z0-9_$]*|0[xX][0-9a-fA-F]+|[0-9]+|[.()[\]+*/%&|^~!<>-])/.exec(
        expression.slice(offset)
      );
    if (!match) return /^\s*$/.test(expression.slice(offset)) && parse();
    tokens.push(match[1]);
    offset += match[0].length;
    if (tokens.length > 128) return false;
  }
  return parse();
  function parse(): boolean {
    let cursor = 0,
      depth = 0;
    const identifier = (token: string | undefined) => !!token && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token);
    const binary = new Set([
      '+',
      '-',
      '*',
      '/',
      '%',
      '&',
      '|',
      '^',
      '<<',
      '>>',
      '<',
      '>',
      '<=',
      '>=',
      '==',
      '!=',
      '&&',
      '||'
    ]);
    function atom(): boolean {
      if (++depth > 32) return false;
      if (['*', '&', '+', '-', '~', '!'].includes(tokens[cursor])) {
        cursor++;
        const valid = atom();
        depth--;
        return valid;
      }
      if (tokens[cursor] === '(') {
        cursor++;
        if (!expr() || tokens[cursor++] !== ')') return false;
      } else if (identifier(tokens[cursor]) || /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(tokens[cursor] ?? ''))
        cursor++;
      else return false;
      while (['.', '->', '['].includes(tokens[cursor])) {
        const op = tokens[cursor++];
        if (op === '[') {
          if (!expr() || tokens[cursor++] !== ']') return false;
        } else if (!identifier(tokens[cursor++])) return false;
      }
      depth--;
      return true;
    }
    function expr(): boolean {
      if (!atom()) return false;
      while (binary.has(tokens[cursor])) {
        cursor++;
        if (!atom()) return false;
      }
      return true;
    }
    return (
      expr() &&
      cursor === tokens.length &&
      !tokens.some((token, index) => (token === '+' || token === '-') && tokens[index + 1] === token)
    );
  }
}
