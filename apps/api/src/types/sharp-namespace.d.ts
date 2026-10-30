// sharp 0.35's ESM types dropped the `sharp` namespace (sharp.Sharp etc.)
// that older code and a locked test use. Re-expose the instance type under
// that name, types only; the runtime package is untouched. 0.35 is needed for
// the libvips/libheif security fixes.
import type { Sharp as SharpInstance } from "sharp";

declare global {
  namespace sharp {
    type Sharp = SharpInstance;
  }
}
export {};
