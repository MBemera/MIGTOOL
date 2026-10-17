import { type Data, type Evaluation, type Pack, same } from './model';
import { evaluate } from './engine';
export function compareValidation(pack: Pack, data: Data, previous: (data: Data) => Evaluation) {
  const current = evaluate(pack, data),
    legacy = previous(data);
  return { matches: same(current, legacy), current, legacy };
}
