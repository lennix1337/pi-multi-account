// Test-only loader for generated protobuf enums on Node versions without transform-types.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
// TypeScript 7 ships no JavaScript API; transpileModule comes from the TypeScript 6 API package.
import ts from '@typescript/typescript6';
registerHooks({load(url,context,nextLoad) {
  if(url.startsWith('file:') && url.endsWith('.ts')) return {
    format:'module',shortCircuit:true,
    source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{
      compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext},
    }).outputText,
  };
  return nextLoad(url,context);
}});
