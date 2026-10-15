import type * as abaplint from "@abaplint/core";

export interface BoolxParser {
  readonly Registry: typeof abaplint.Registry;
  readonly MemoryFile: typeof abaplint.MemoryFile;
}
interface TokenEdit { readonly at: number; readonly text: string }

// abaplint's BOOLX table expects a character source, while ABAP takes log_exp.
// Bridge that grammar gap with BOOLC before parsing; tokens protect literals,
// comments and nested calls, and inserted text never adds a source line.
export function lowerBoolx(source: string, filename: string, core: BoolxParser): string {
  if (!/\.abap$/i.test(filename) || !/\bboolx\s*\(/i.test(source)) return source;
  const reg = new core.Registry().addFile(new core.MemoryFile(filename, source)).parse();
  // This registry contains only the .abap MemoryFile admitted above.
  const object = reg.getFirstObject() as abaplint.ABAPObject | undefined;
  const tokens = object?.getABAPFiles().find((f): boolean => f.getFilename() === filename)?.getTokens()
    .filter((t): boolean => t.constructor.name !== "Comment") ?? [];
  const word = (i: number): string | undefined => tokens[i]?.getStr().toUpperCase();
  const offset = (t: abaplint.Token): number => {
    const pos = t.getStart();
    let start = 0;
    for (let row = 1; row < pos.getRow(); row++) start = source.indexOf("\n", start) + 1;
    return start + pos.getCol() - 1;
  };
  const edits: TokenEdit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (["->", "=>"].includes(word(i-1) ?? "") || word(i) !== "BOOLX" || word(i+1) !== "(" || word(i+2) !== "BOOL" || word(i+3) !== "=") continue;
    let depth = 0, end = i+4, bit: number | undefined;
    for (; end < tokens.length; end++) {
      const w = word(end);
      if (depth === 0 && w === ")") break;
      if (depth === 0 && w === "BIT" && word(end+1) === "=" && end > i+4) bit = end;
      if (w === "(") depth++;
      else if (w === ")") depth--;
    }
    if (end === tokens.length || end === i+4) continue;
    end = bit ?? end;
    edits.push({at: offset(tokens[i+4]), text: "boolc( "}, {at: offset(tokens[end]), text: ") "});
  }
  for (const edit of edits.sort((a,b): number => b.at-a.at)) source = source.slice(0,edit.at)+edit.text+source.slice(edit.at);
  return source;
}
