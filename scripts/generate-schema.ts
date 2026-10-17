import { writeFileSync } from 'node:fs';
import { loadPack } from '../packages/adapters/config';
import { fields } from '../packages/core/model';
const pack = loadPack(),
  root: any = {};
for (const { field, path } of fields(pack)) {
  let node = root;
  const keys = path.split('.');
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].replace('[*]', ''),
      array = keys[i].includes('[*]');
    if (i === keys.length - 1)
      node[key] = {
        type: ['currency', 'number'].includes(field.type)
          ? 'number'
          : field.type === 'boolean'
            ? 'boolean'
            : 'string',
        array,
      };
    else {
      node[key] ??= { children: {}, array };
      node = node[key].children;
    }
  }
}
function render(node: any, indent = '  '): string {
  return Object.entries(node)
    .map(
      ([key, v]: [string, any]) =>
        `${indent}${JSON.stringify(key)}?: ${v.children ? '{\n' + render(v.children, indent + '  ') + indent + '}' : v.type}${v.array ? '[]' : ''};\n`,
    )
    .join('');
}
writeFileSync(
  'packages/core/aaf-data.generated.ts',
  `// Generated from config/schema.yaml by npm run generate:schema.\nexport interface AafData {\n${render(root)}}\n`,
);
console.log(`Generated AafData from ${pack.schema.version}`);
