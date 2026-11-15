
declare const __TARKA_BUILD__: string | undefined;

export const IS_BUILD: boolean = typeof __TARKA_BUILD__ !== 'undefined';

export const BUILD_STAMP: string = IS_BUILD ? (__TARKA_BUILD__ as string) : 'not a build (run from source)';
