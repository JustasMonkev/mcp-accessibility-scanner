export type ProgramMode = 'default' | 'extension' | 'vscode';

export type ProgramModeOptions = {
  extension?: boolean;
  vscode?: boolean;
};

export function resolveProgramMode(options: ProgramModeOptions): ProgramMode {
  if (options.extension)
    return 'extension';
  if (options.vscode)
    return 'vscode';
  return 'default';
}
