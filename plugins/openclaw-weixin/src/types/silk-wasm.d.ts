declare module "silk-wasm" {
  export type SilkDecodeResult = {
    data: Uint8Array;
    duration: number;
  };

  export function decode(input: Uint8Array, sampleRate: number): Promise<SilkDecodeResult>;
}
