const PLAYWRIGHT_PACKAGE_LOOKUP = /require\.resolve\((["'])(?:\.\/)?(?:\.\.\/)+package\.json\1\)/g;

export interface RewriteResult {
  contents: string;
  replacements: number;
}

export function rewritePlaywrightPackageLookups(source: string): RewriteResult {
  let replacements = 0;
  const contents = source.replace(PLAYWRIGHT_PACKAGE_LOOKUP, () => {
    replacements++;
    return "process.execPath";
  });
  return { contents, replacements };
}
