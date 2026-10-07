import { describe, expect, it } from 'vitest';
import {
  describeCommand,
  describePrompt,
  describeShellJob,
  describeTool,
  describeWaitingFor,
  looksPortuguese,
  maskSecrets,
  shellWords,
  SPECIAL,
  splitShell,
} from './activity';

describe('describeCommand', () => {
  it('só a primeira linha decide (heredoc não confunde)', () => {
    expect(describeCommand("cat > /tmp/x/notas.md <<'EOF'\nrodar vitest depois\nEOF").text).toBe('Escrevendo notas.md');
    expect(describeCommand("cat <<'EOF' > server/README.md\n# x\nEOF").text).toBe('Escrevendo README.md');
    expect(describeCommand("python3 - <<'EOF'\nimport os\nEOF").text).toBe('Executando um script Python');
    expect(describeCommand("node -e 'console.log(1)'").text).toBe('Executando um script Node');
  });

  it('comandos comuns', () => {
    expect(describeCommand('npx vitest run server').text).toBe('Rodando testes');
    expect(describeCommand('cd /x && git commit -m "feat"').text).toBe('Fazendo commit');
    expect(describeCommand('node scripts/shot.mjs http://x out.png').text).toBe('Executando shot.mjs');
    expect(describeCommand('tail -n 20 server.log').text).toBe('Lendo server.log');
    expect(describeCommand('tee -a log.txt').text).toBe('Escrevendo log.txt');
  });
});

describe('describeCommand em português (casos reais que caíam no inglês)', () => {
  const t = (cmd: string, desc?: string) => describeCommand(cmd, desc).text;

  it('primeira linha com comando de verdade; prefixos e atribuições não contam', () => {
    expect(t('S=/tmp/x\nnode scripts/shot.mjs x $S/a.png', 'Screenshot real-data UI on port 4763')).toBe('Executando shot.mjs');
    expect(t('CODETOWN_PORT=1 nohup npx tsx server/index.ts --dev > /tmp/s.log 2>&1 &', 'Start real-data server')).toBe('Executando index.ts');
    expect(t('set -e\nexport A=1\n# comentário\nnpm test')).toBe('Rodando testes');
    expect(t('sleep 5 && curl -s localhost:4771/')).toBe('Testando o servidor local (:4771/)');
    expect(t('(cd client && npm test)')).toBe('Rodando testes');
    expect(t('bash -c "npm run build"')).toBe('Compilando o projeto');
    // Substituição de comando é parte da atribuição, não um comando.
    expect(t('S=/tmp/x; NOW=$(date +%s); echo "{\\"a\\":$((NOW+1))}" | HOME=$S node scripts/statusline-tap.mjs; ls $S')).toBe('Executando statusline-tap.mjs');
  });

  it('leitores cortados no primeiro |, ; ou &&', () => {
    expect(t('sed -n 1,80p rug.ts', 'Read art rug implementation')).toBe('Lendo rug.ts');
    expect(t("sed -n '140,700p' server/sources/transcript.ts")).toBe('Lendo transcript.ts');
    expect(t('cat a.ts b.ts | head -700')).toBe('Lendo a.ts e b.ts');
    expect(t('cat a.ts b.ts c.ts')).toBe('Lendo a.ts e mais 2');
    expect(t('head -30 x.ts; ls | head')).toBe('Lendo x.ts');
    expect(t("awk '{print $1}' data.csv")).toBe('Lendo data.csv');
    expect(t('tail -f /tmp/server.log')).toBe('Acompanhando server.log');
    expect(t('wc -l server/*.ts shared/*.ts scripts/*')).toBe('Contando linhas de 3 arquivos');
    expect(t('echo "---"; tail -n 20 server.log')).toBe('Lendo server.log');
  });

  it('processos, rede, busca e edição', () => {
    expect(t('pkill -f "vite.*4771"', 'Stop preview')).toBe('Parando um processo');
    expect(t('ps aux | grep vite')).toBe('Conferindo processos');
    expect(t('lsof -i :4771')).toBe('Conferindo quem usa a porta 4771');
    expect(t('curl -s localhost:4763/api/snapshot | jq .rev')).toBe('Testando a API local (:4763/api/snapshot)');
    expect(t('curl http://127.0.0.1:4747/api/health')).toBe('Testando a API local (:4747/api/health)');
    expect(t('curl -o out.png -sS https://www.example.com/x.png')).toBe('Chamando example.com');
    expect(t('grep "a\\|b" file.ts')).toBe('Buscando “a | b”');
    expect(t('sed -i "" "s/a/b/" src/x.ts')).toBe('Editando x.ts');
    expect(t('echo "oi" > saida.txt')).toBe('Escrevendo saida.txt');
    expect(t('npx tsc --noEmit -p server/tsconfig.json')).toBe('Conferindo os tipos (TypeScript)');
    expect(t('VITE_PORT=4771 nohup npx vite --config vite.config.ts --strictPort > x.log 2>&1 &')).toBe('Subindo o servidor de dev');
    expect(t('git -C /x status --short')).toBe('Conferindo o git status');
    expect(t('npm run docker:up -- --no-build')).toBe('Rodando o script docker:up');
  });

  it('laços: o corpo decide', () => {
    expect(t('for f in a.ts b.ts; do wc -l $f; done')).toBe('Contando linhas');
    expect(t('for f in *.ts\ndo\n  cat $f\ndone')).toBe('Lendo arquivo');
  });

  it('description só vira texto em português; senão, texto genérico em PT-BR e description no detalhe', () => {
    expect(t('ffmpeg -i a.mp4 b.gif', 'Converte o vídeo para gif')).toBe('Converte o vídeo para gif');
    const en = describeCommand('ffmpeg -i a.mp4 b.gif', 'Convert video to gif');
    expect(en.text).toBe('Rodando ffmpeg');
    expect(en.detail).toBe('Convert video to gif — ffmpeg -i a.mp4 b.gif');
    expect(t('$(weird) | x')).toBe('Rodando um comando no terminal');
    expect(looksPortuguese('Count transcripts containing cost-state lines')).toBe(false);
    expect(looksPortuguese('Roda os testes do servidor')).toBe(true);
  });
});

describe('segredos mascarados', () => {
  it('comandos com tokens, senhas e chaves', () => {
    const d = describeCommand('curl -sS -H "Authorization: Bearer FAKE_TOKEN_123" https://api.example.com/v1');
    expect(d.text).toBe('Chamando api.example.com');
    expect(d.detail).toBe('curl -sS -H "Authorization: ***" https://api.example.com/v1');
    expect(describeCommand('curl -u admin:s3cr3t https://x.com/api').detail).toBe('curl -u admin:*** https://x.com/api');
    expect(describeCommand('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 gh pr list').detail).toBe('GITHUB_TOKEN=*** gh pr list');
    expect(describeCommand('psql "postgres://user:pa55word@db.host:5432/app"').detail).toBe('psql "postgres://user:***@db.host:5432/app"');
    expect(maskSecrets('x sk-ant-api03-abcdefghijklmnop y')).toBe('x sk-*** y');
    expect(maskSecrets('Bearer abcdef123456')).toBe('Bearer ***');
    expect(maskSecrets('curl "https://x.com/?token=abc&x=1" --password hunter2')).toBe('curl "https://x.com/?token=***&x=1" --password ***');
    expect(maskSecrets('{"password": "x", "max_tokens": 100}')).toBe('{"password": "***", "max_tokens": 100}');
    expect(maskSecrets('AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f')).toBe('AKIA*** eyJ***');
    // Prompt do usuário com um token colado.
    expect(describePrompt('usa a chave sk-proj-0123456789abcdef pra testar').detail).toBe('usa a chave sk-*** pra testar');
  });

  it('shell: palavras e segmentos', () => {
    expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g ''`)).toEqual(['a', 'b c', 'd "e"', 'f g', '']);
    expect(splitShell('a && b | c; d & e 2>&1 || f "x|y" $(g; h)')).toEqual(['a', 'b', 'c', 'd', 'e 2>&1', 'f "x|y" $(g; h)']);
    expect(shellWords('X=$(date +%s) y `a b` z')).toEqual(['X=$(date +%s)', 'y', '`a b`', 'z']);
  });
});

describe('atividades', () => {
  it('ferramentas e especiais em PT-BR', () => {
    expect(describeTool('Agent', { description: 'Revisar código', subagent_type: 'Explore' })).toMatchObject({ kind: 'delegate', text: 'Delegando: Revisar código' });
    expect(SPECIAL.rejected('Write').text).toBe('Você recusou: Write');
    expect(SPECIAL.cleared().kind).toBe('compact');
    expect(describeWaitingFor('worker request')).toBe('aprovar o pedido de um worker');
    expect(describeWaitingFor(undefined)).toBe('responder no terminal');
  });
});

describe('shells', () => {
  it('rótulo do job: description (mascarada) ou resumo do comando; comando mascarado no detalhe', () => {
    expect(describeShellJob('Bash', { command: 'vendor/bin/phpunit', description: 'Rodar a suíte completa em grupos com phpunit' })).toEqual({
      label: 'Rodar a suíte completa em grupos com phpunit',
      command: 'vendor/bin/phpunit',
      kind: 'shell',
    });
    expect(describeShellJob('Bash', { command: 'GITHUB_TOKEN=ghp_0123456789abcdefghij npm run build' })).toEqual({
      label: 'Compilando o projeto',
      command: 'GITHUB_TOKEN=*** npm run build',
      kind: 'shell',
    });
    expect(describeShellJob('Bash', { command: 'x', description: 'Deploy com --token abc123def456 em produção de um serviço muito importante' }).label).toBe(
      'Deploy com --token *** em produção de um serv…',
    );
    expect(describeShellJob('Monitor', { description: 'erros no deploy.log', command: 'tail -f deploy.log' })).toMatchObject({ label: 'erros no deploy.log', kind: 'monitor' });
    expect(describeShellJob('Monitor', { ws: { url: 'wss://events.example.com/stream' } })).toEqual({
      label: 'Escutando events.example.com',
      command: 'wss://events.example.com/stream',
      kind: 'monitor',
    });
  });

  it('balão de espera e fim do shell (marcadores para o mundo), sempre em até 46 caracteres com a duração inteira', () => {
    expect(SPECIAL.waitingShell('Rodar a suíte')).toMatchObject({ kind: 'wait', icon: '⏳', text: 'Esperando o shell: Rodar a suíte', tool: 'ShellWait' });
    expect(SPECIAL.waitingShell('Build', 3).text).toBe('Esperando 3 shells: Build');
    expect(SPECIAL.waitingShell(undefined).text).toBe('Esperando o shell');
    const ok = SPECIAL.shellDone('Rodar a suíte completa em grupos com phpunit', 'ok', 482_000, 'vendor/bin/phpunit');
    expect(ok).toEqual({ kind: 'run', icon: '✅', text: 'Shell terminou: Rodar a suíte compl… (8min 2s)', detail: 'vendor/bin/phpunit', tool: 'ShellDone' });
    expect(ok.text.length).toBeLessThanOrEqual(46);
    expect(SPECIAL.shellDone('Migração', 'failed')).toEqual({ kind: 'run', icon: '❌', text: 'Shell falhou: Migração', tool: 'ShellDone', error: true });
    expect(SPECIAL.shellDone('Migração', 'killed')).toMatchObject({ icon: '🛑', text: 'Shell interrompido: Migração', error: true });
  });
});
