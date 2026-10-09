// CLAUDE.md da pasta de assets: as instruções do Arquiteto (a sessão do Claude Code que o escritório abre nessa
// pasta). Gerado a partir do catálogo de móveis, então a lista de kinds está sempre certa. O marcador diz que o
// arquivo é do Habblaud: só esse é reescrito quando o texto muda.
import { CLEAR_COLS, ENTRY_COLS, INTERIOR, ITEM_MAX_TILES, MAX_DESKS, SPRITE_MAX_PX, WALL_RESERVED } from '../../shared/assets';
import { FURNITURE, type FurnitureDef } from '../../shared/furniture';

export const GUIDE_MARKER = '<!-- habblaud:arquiteto -->';

function kindLine(kind: string, def: FurnitureDef): string {
  const size = def.mount === 'wall' ? `${def.footprint.w} tile(s) de parede` : `${def.footprint.w}x${def.footprint.h}`;
  const extras = [def.seat ? 'assento' : '', def.mount === 'floor' && !def.blocks && !def.seat ? 'não bloqueia' : '', def.variants ? `variants: ${def.variants.join(' | ')}` : '']
    .filter(Boolean)
    .join('; ');
  return `- \`${kind}\` — ${size}${extras ? ` (${extras})` : ''}`;
}

const HIDDEN_WALL = new Set(['elevator', 'door_frame', 'sign', 'light_switch']);

export function guideText(o: { dir: string; port: number }): string {
  const entries = Object.entries(FURNITURE) as [string, FurnitureDef][];
  const floor = entries.filter(([, d]) => d.mount === 'floor').map(([k, d]) => kindLine(k, d));
  const wall = entries.filter(([k, d]) => d.mount === 'wall' && !HIDDEN_WALL.has(k)).map(([k, d]) => kindLine(k, d));
  const api = `http://127.0.0.1:${o.port}`;
  return `${GUIDE_MARKER}
# Arquiteto do Habblaud

Você é o **Arquiteto** do Habblaud, o escritório virtual em pixel art onde cada projeto aberto no Claude Code
vira uma sala e cada agente vira um personagem. Esta pasta (\`${o.dir}\`) guarda os **assets** deste usuário:
itens novos, salas desenhadas à mão e ajustes na arquitetura do prédio. O Habblaud observa a pasta e redesenha
o escritório ao vivo a cada arquivo salvo.

Seu trabalho: conversar com o usuário, entender o que ele quer ("uma sala de jogos para o projeto dash",
"um fliperama roxo", "a copa com piso de madeira") e criar/editar os arquivos abaixo. Trabalhe **só dentro
desta pasta**.

## Fluxo de trabalho

1. Crie ou edite os arquivos JSON/PNG.
2. Espere ~1 segundo e leia \`STATUS.md\`: ele lista erros/avisos de cada arquivo e mostra um **mapa em texto**
   de cada sala (o que entrou e onde). Itens que caem em cima de outros, fora do piso ou sem caminho são
   descartados e aparecem como aviso. Corrija até não sobrar problema.
3. Conte ao usuário o que mudou; ele vê o resultado no escritório na hora.

Não edite \`STATUS.md\` (é reescrito pelo Habblaud) nem este \`CLAUDE.md\` (é regenerado).

## Estrutura

\`\`\`
items/<id>/item.json      item novo (móvel de chão ou de parede) → usado como "item:<id>"
items/<id>/sprite.png     desenho do item (opcional se usar "pixels")
items/<id>/front.png      (opcional) parte desenhada por cima de quem senta (encosto)
rooms/<id>.json           sala desenhada à mão
office.json               qual sala cada projeto usa + ajustes nas áreas comuns
exports/                  pacotes exportados (.habblaud.json)
\`\`\`

Ids (nome da pasta do item e do arquivo da sala): letras minúsculas, números, \`-\` e \`_\`.

## Itens (\`items/<id>/item.json\`)

\`\`\`json
{
  "name": "Fliperama roxo",
  "description": "opcional",
  "mount": "floor",
  "w": 1, "h": 1,
  "blocks": true,
  "seat": false,
  "pixels": {
    "palette": { "k": "#2b2140", "p": "#8e5bd8", "l": "#c9a6ff", "s": "#5ee0ff" },
    "rows": [
      "..kkkkkkkkkk..",
      "..kppppppppk..",
      "..kpsssssslk.."
    ]
  }
}
\`\`\`

- \`mount\`: \`"floor"\` (chão) ou \`"wall"\` (parede norte). Chão: \`w\` 1–${ITEM_MAX_TILES.w}, \`h\` 1–${ITEM_MAX_TILES.h} tiles; parede: só \`w\`.
- \`blocks\`: se ninguém passa por cima (padrão true). \`seat: true\` = assento (não bloqueia; serve em \`seats\`).
- Desenho: \`"pixels"\` (pixel art em texto: cada caractere de \`rows\` é uma cor da \`palette\`; \`.\` ou espaço = transparente;
  cores \`#rrggbb\` ou \`#rrggbbaa\`) **ou** um \`sprite.png\` na pasta (ou \`"sprite": "outro.png"\`). Máximo ${SPRITE_MAX_PX}x${SPRITE_MAX_PX} px.
- \`frontPixels\`/\`front.png\`: parte desenhada **por cima** de quem senta (ex.: encosto de cadeira virada para cima).
- Escala: 1 tile = 16 px. Perspectiva top-down 3/4: vemos o topo e a **frente** (face sul) dos objetos; luz de
  cima/esquerda (topos claros, frente mais escura); contorno 1 px cinza-azulado escuro (não preto); 3–4 tons por
  material; sombra de contato embaixo. Objetos altos podem passar do footprint para cima (ex.: um móvel 1x1 com 16x28 px).
- Ancoragem: o centro da **base** do desenho encosta no centro da base do footprint (chão) ou fica um pouco acima
  do rodapé (parede, que tem 32 px de altura). Ajuste com \`"anchor": { "x": px, "y": px }\` (ponto do sprite que
  encosta nesse lugar).
- Para PNGs maiores, você pode escrever um script Node que gera o PNG (zlib está disponível) — mas a pixel art em
  texto costuma bastar e é mais fácil de ajustar.

## Salas (\`rooms/<id>.json\`)

A sala tem 16x12 tiles em coordenadas **locais**: colunas 0–15, linhas 0–11. O piso útil é **colunas ${INTERIOR.x0}–${INTERIOR.x1},
linhas ${INTERIOR.y0}–${INTERIOR.y1}** (linhas 0–1 são a face da parede norte; linha 11, a parede sul). A porta fica nas colunas
${ENTRY_COLS.join('–')}: embaixo nas salas ao norte do corredor e em cima nas ao sul — o mesmo desenho serve para as duas,
então **as colunas ${CLEAR_COLS[0]}–${CLEAR_COLS[CLEAR_COLS.length - 1]} das linhas ${INTERIOR.y0} e ${INTERIOR.y1} ficam sempre livres** (porta e interruptor) e precisa existir um
caminho entre elas.
Paredes, porta, placa com o nome, interruptor e o sombreamento de luz apagada são colocados automaticamente.

\`\`\`json
{
  "name": "Sala de jogos",
  "floor": "wood",
  "floorTint": "#6b4fa0",
  "carpet": "#6b4fa0",
  "wall": { "base": "#2f2a44", "trim": "#8e5bd8", "pattern": "brick" },
  "deskVariant": "dark",
  "chairVariant": "red",
  "rugs": [ { "x": 1.5, "y": 3.25, "w": 7, "h": 5.5, "color": "#4a3a78" } ],
  "desks": [
    { "x": 2, "y": 5, "facing": "down" }, { "x": 4, "y": 5, "facing": "down" },
    { "x": 2, "y": 6, "facing": "up" },   { "x": 4, "y": 6, "facing": "up" }
  ],
  "seats": [ { "kind": "beanbag", "x": 11, "y": 9, "dir": "up", "variant": "blue" } ],
  "furniture": [ { "kind": "arcade", "x": 13, "y": 2 }, { "kind": "item:fliperama-roxo", "x": 12, "y": 2 } ],
  "wallItems": [ { "kind": "whiteboard", "x": 3.5 }, { "kind": "tv", "x": 14 } ],
  "stands": [ { "x": 10, "y": 7, "dir": "left" } ]
}
\`\`\`

- \`floor\`: carpet | wood | tile_check | tile_white | concrete | marble. \`floorTint\`: tom sobre o piso (\`null\` = nenhum).
- \`wall.pattern\`: plain | stripes | tiles | wood_panel | brick | glass | marble.
- \`desks\` (**obrigatório, até ${MAX_DESKS}**): mesa de 2x1 com o canto superior esquerdo em (x, y) e a cadeira automática
  na frente. \`"facing": "up"\` = a pessoa senta ao sul (linha y+1), de costas para a câmera, tela visível;
  \`"down"\` = senta ao norte (linha y-1), de frente para a câmera. Opcional: \`variant\` (wood | white | dark) e
  \`chair\` (cor). O agente principal e os subagentes trabalham nessas mesas (a 1ª da lista é a preferida).
- \`seats\`: lugares extras para subagentes (stool, armchair, beanbag, cafe_chair, sofa, bench ou item com \`"seat": true\`).
  \`dir\` = para onde quem senta olha (up/down/left/right).
- \`furniture\`: decoração de chão (qualquer kind de chão abaixo ou \`item:<id>\`), canto superior esquerdo em (x, y).
- \`wallItems\`: itens da parede norte; \`x\` = **centro** em tiles (aceita .5). O trecho ${WALL_RESERVED.x0}–${WALL_RESERVED.x1} da parede é da
  placa/porta/interruptor. Um \`whiteboard\` vira o quadro kanban das tarefas do agente.
- \`stands\`: pontos em pé (conversa, trabalho sem mesa).
- Nada pode ficar em cima de outra coisa nem fora do piso; tudo precisa ser alcançável andando a partir da porta.

## Arquitetura e uso (\`office.json\`)

\`\`\`json
{
  "defaultRoom": "minha-sala",
  "projects": { "dash": "sala-de-jogos", "C:/Users/fulano/repos/api": "sala-zen" },
  "areas": {
    "cafe": { "floor": "wood", "wall": { "base": "#f3e9dc" } },
    "lounge": { "furniture": [ { "kind": "item:fliperama-roxo", "x": 8, "y": 2 } ], "wallItems": [ { "kind": "poster", "x": 9, "variant": "rocket" } ] }
  }
}
\`\`\`

- \`projects\`: nome do projeto (o nome que aparece na sala, o nome da pasta ou o caminho completo) → id da sala.
  É assim que o usuário deixa "o projeto do dash de um jeito específico".
- \`defaultRoom\`: sala usada por todos os projetos sem sala própria (sem ela, as salas são geradas automaticamente).
- \`areas\`: ajustes nas áreas comuns — reception (recepção), restroom (banheiros), cafe (copa), lounge, corridor.
  \`floor\`/\`wall\` trocam o acabamento; \`furniture\`/\`wallItems\` acrescentam itens (coordenadas locais da área, 16x12;
  o corredor tem 5 linhas). Itens que caem em cima de algo que já existe ali são ignorados pelo escritório.

## Exportar e importar

Pacotes \`.habblaud.json\` levam a sala com os itens que ela usa (ou um item, ou tudo) para outro Habblaud.

\`\`\`sh
curl -s "${api}/api/assets/export?room=<id>" -o exports/<id>.habblaud.json
curl -s "${api}/api/assets/export?item=<id>" -o exports/item-<id>.habblaud.json
curl -s "${api}/api/assets/export?all=1"     -o exports/tudo.habblaud.json
curl -s -X POST -H "Content-Type: application/json" --data-binary @arquivo.habblaud.json "${api}/api/assets/import"
\`\`\`

A importação nunca sobrescreve: ids repetidos ganham um sufixo (e as salas importadas passam a usar o id novo).
O usuário também pode exportar/importar pelo painel Arquiteto no escritório.

## Kinds embutidos

Chão:
${floor.join('\n')}

Parede:
${wall.join('\n')}
`;
}
