// Comando de verdade dentro do invólucro do shell (sh/bash/zsh -lc, pwsh -Command, cmd /c), em lista ou em texto.
import { describe, expect, it } from 'vitest';
import { unwrapCommand } from './command';

describe('unwrapCommand: lista (CommandExecution/exec)', () => {
  it.each([
    [['/bin/zsh', '-lc', 'npm test'], 'npm test'],
    [['bash', '-c', 'ls -la'], 'ls -la'],
    [['sh', '-c', 'echo oi'], 'echo oi'],
    [['/usr/bin/dash', '-c', 'make'], 'make'],
    [['ksh', '-c', 'make'], 'make'],
    [['fish', '-c', 'make'], 'make'],
    [['C:\\Program Files\\Git\\bin\\bash.exe', '-lc', 'git status'], 'git status'],
    [['bash', '--noprofile', '--norc', '-c', 'make'], 'make'],
    [['bash', '-o', 'pipefail', '-c', 'make | tee log'], 'make | tee log'],
    // Depois da string do -c vêm os parâmetros posicionais ($0, $1...), que não são o comando.
    [['sh', '-c', 'echo "$0"', 'arg0'], 'echo "$0"'],
    // -C maiúsculo (noclobber no bash) não é o -c.
    [['bash', '-C', '-c', 'make'], 'make'],
  ])('POSIX %j → %s', (cmd, text) => {
    expect(unwrapCommand(cmd)).toEqual({ text, shell: 'sh' });
  });

  it.each([
    [['pwsh.exe', '-Command', 'git status'], 'git status'],
    [['powershell.exe', '-NoProfile', '-Command', 'Get-ChildItem -Force'], 'Get-ChildItem -Force'],
    [['pwsh', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-c', 'npm test'], 'npm test'],
    [['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-noprofile', '-COMMAND', 'git', 'push'], 'git push'],
    [['POWERSHELL', '-NoProfile', '-Command', 'Get-Date'], 'Get-Date'],
  ])('PowerShell %j → %s', (cmd, text) => {
    expect(unwrapCommand(cmd)).toEqual({ text, shell: 'pwsh' });
  });

  it.each([
    [['cmd.exe', '/d', '/s', '/c', 'dir'], 'dir'],
    [['C:\\Windows\\System32\\cmd.exe', '/C', 'echo', 'oi'], 'echo oi'],
    [['cmd', '/k', 'ver'], 'ver'],
    [['cmd.exe', '/D', '/S', '/C', '"git push"'], 'git push'],
    // Aspas que não envolvem tudo ficam (o Rust é quem põe as aspas externas da linha de comando).
    [['cmd.exe', '/d', '/s', '/c', '"C:\\x y\\a.exe" arg'], '"C:\\x y\\a.exe" arg'],
  ])('cmd %j → %s', (cmd, text) => {
    expect(unwrapCommand(cmd)).toEqual({ text, shell: 'cmd' });
  });

  it('sem invólucro: as palavras juntadas como hoje (com aspas onde há espaço)', () => {
    expect(unwrapCommand(['git', 'commit', '-m', 'uma mensagem'])).toEqual({ text: "git commit -m 'uma mensagem'", shell: null });
    expect(unwrapCommand(['bash', 'build.sh'])).toEqual({ text: 'bash build.sh', shell: null });
    // Flag sem comando depois, -File e -EncodedCommand não são invólucro.
    expect(unwrapCommand(['bash', '-lc'])).toEqual({ text: 'bash -lc', shell: null });
    expect(unwrapCommand(['pwsh', '-File', 'build.ps1'])).toEqual({ text: 'pwsh -File build.ps1', shell: null });
    expect(unwrapCommand(['pwsh', '-EncodedCommand', 'ZwBpAHQA'])).toEqual({ text: 'pwsh -EncodedCommand ZwBpAHQA', shell: null });
    expect(unwrapCommand(['cmd.exe', '/c'])).toEqual({ text: 'cmd.exe /c', shell: null });
    // fish -C '<inicialização>' -c cmd: o -C não é o -c (o comando de inicialização nunca passa por comando).
    expect(unwrapCommand(['fish', '-C', 'set x 1', '-c', 'make'])).toEqual({ text: "fish -C 'set x 1' -c make", shell: null });
  });
});

describe('unwrapCommand: texto', () => {
  it.each([
    ['pwsh -NoProfile -Command "git status"', 'git status', 'pwsh'],
    ['powershell.exe -Command Get-Date', 'Get-Date', 'pwsh'],
    ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "git commit -m \\"msg\\""', 'git commit -m "msg"', 'pwsh'],
    // Várias palavras depois da flag: o resto cru (as aspas internas ficam).
    ['pwsh -Command git commit -m "a b"', 'git commit -m "a b"', 'pwsh'],
    ["bash -lc 'npm test'", 'npm test', 'sh'],
    [`bash -c '"a" && "b"'`, '"a" && "b"', 'sh'],
    ['/bin/zsh -lc npm test', 'npm test', 'sh'],
    ['cmd /d /s /c "dir /b"', 'dir /b', 'cmd'],
    // /s: o cmd tira a primeira e a última aspa da linha.
    ['cmd.exe /d /s /c ""C:\\x y\\a.exe" arg"', '"C:\\x y\\a.exe" arg', 'cmd'],
    // Aspa sem fechar: o resto vale.
    ['pwsh -Command "git status', 'git status', 'pwsh'],
  ])('%s → %s', (cmd, text, shell) => {
    expect(unwrapCommand(cmd)).toEqual({ text, shell });
  });

  it('texto sem invólucro fica como está (só o trim)', () => {
    expect(unwrapCommand('  echo oi ')).toEqual({ text: 'echo oi', shell: null });
    expect(unwrapCommand('git push origin main')).toEqual({ text: 'git push origin main', shell: null });
    expect(unwrapCommand('bash build.sh')).toEqual({ text: 'bash build.sh', shell: null });
    expect(unwrapCommand('pwsh -NoProfile -Command')).toEqual({ text: 'pwsh -NoProfile -Command', shell: null });
  });
});

describe('unwrapCommand: invólucro dentro de invólucro e entrada inválida', () => {
  it('desembrulha até o comando de verdade (shell = o de dentro)', () => {
    expect(unwrapCommand(['pwsh.exe', '-Command', 'cmd /c dir'])).toEqual({ text: 'dir', shell: 'cmd' });
    expect(unwrapCommand(['cmd.exe', '/c', 'bash -lc "npm test"'])).toEqual({ text: 'npm test', shell: 'sh' });
  });

  it.each([[42], [null], [undefined], [{}], [[]], [[1, 2]], [''], ['   ']])('%j → vazio, sem lançar', (cmd) => {
    expect(unwrapCommand(cmd)).toEqual({ text: '', shell: null });
  });
});
