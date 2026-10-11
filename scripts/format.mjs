import ts from 'typescript';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
// Deterministic formatter using the already pinned TypeScript compiler.
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
for (const dir of ['src', 'test', 'examples']) {
  for (const name of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
    const file = `${dir}/${name}`;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const multiline = node => {
      if (ts.isBlock(node) || ts.isObjectLiteralExpression(node)) node.multiLine = true;
      ts.forEachChild(node, multiline);
    };
    multiline(source);
    writeFileSync(file, printer.printFile(source));
  }
}
