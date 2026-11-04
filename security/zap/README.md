# security/zap — OWASP ZAP (varredura passiva da API)

Configuração do **ZAP** para o critério da Onda 6b: _"ZAP baseline sem alertas High/Medium"_
([plano](../../docs/plan/implementation-waves.md)). Esta pasta só prepara o material (Onda 6a); a execução no
preview é ação externa da 6b, com confirmação do dono.

| Arquivo          | Função                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `zap-rules.tsv`  | Regras: `FAIL` para guardas de regressão (headers obrigatórios, vazamento, cookies), `IGNORE` só para falsos positivos justificados, o resto `WARN`. |
| `run-zap.sh`     | Roda o container, aplica as regras e o gate de severidade. Alvo por `TARGET_URL`.                      |
| `check-report.mjs` | Lê `report.json` e reprova se houver alerta **High ou Medium** (o formato `.tsv` não filtra por risco). |

## Por que passivo (`zap-api-scan.py -S`) e não o baseline puro

- O ZAP _baseline_ clássico faz spider de HTML. Esta API só devolve JSON e quase não tem links, então o spider
  não enxergaria as rotas. O `zap-api-scan.py -f openapi` importa `contracts/openapi.v1.yaml` e visita cada
  operação; com `-S` (safe mode) **não** roda o scan ativo.
- Scan ativo está fora de escopo: ele dispara payloads fuzzados em `POST /v1/leads`, criando leads, gastando
  cota de Turnstile/Redis e acionando o bloqueio por falhas de bot. Se for desejado, é decisão do dono, em
  banco descartável, com janela combinada.
- `ZAP_MODE=baseline` existe como _smoke_ (varre só `GET /v1/health`).

## Imagem e versão

`zaproxy/zap-stable:2.17.0` — **pinada por tag de versão** (2.17.0 é a última release estável em
2025-12-15). A pinagem por **digest** fica como passo da 6b, quando houver rede e confirmação:

```bash
docker pull zaproxy/zap-stable:2.17.0
docker image inspect --format '{{index .RepoDigests 0}}' zaproxy/zap-stable:2.17.0
# usar o valor sha256:... em ZAP_IMAGE e no workflow da 6b
```

Tags são mutáveis; um workflow no CI deve usar o digest (política de supply chain do projeto).

## Como rodar

Pré-requisitos: Docker e Node 24 (para o gate). O container acessa um mock no host via
`host.docker.internal`.

```bash
# 1) Local, contra o mock do contrato (valida a configuração, não mede a API real)
npx @stoplight/prism-cli mock contracts/openapi.v1.yaml -p 4010 &
TARGET_URL=http://host.docker.internal:4010 security/zap/run-zap.sh

# 2) Preview (Onda 6b) — ação externa: o dono confirma a URL; nunca produção
TARGET_URL=https://<preview>.vercel.app CONFIRM_REMOTE=yes security/zap/run-zap.sh
```

O script cria um diretório temporário (ou `ZAP_OUT_DIR`) com `report.html` e `report.json`, imprime o caminho
e termina com `0` (passou), `1` (regra `FAIL` ou High/Medium) ou `3` (erro do scan). Os relatórios podem
conter URLs e trechos de resposta do preview: não os comite nem os anexe a PRs públicos sem revisar.

> **Estado na Onda 6a:** o ambiente da sessão não tinha Docker (WSL sem integração), então **o ZAP não foi
> executado**; apenas a sintaxe do script, o `sed` que aponta o contrato para o alvo, os guardas de
> `TARGET_URL`/`CONFIRM_REMOTE` e o `check-report.mjs` (com relatório sintético) foram exercitados. Rode o
> item 1 ao abrir a 6b para validar o formato do `.tsv` e os IDs das regras na versão pinada.

## Cuidados no preview

- A varredura envia, para `POST /v1/leads`, o exemplo do contrato: espere `400/403/429` e entradas de
  `antibot.failures`/`ratelimit.blocked` nos logs. Não é incidente: avise o dono antes (alertas da 6b).
- O IP do scanner pode ser bloqueado por 1 h pelo bloqueio de falhas de bot (≥ 10 falhas Turnstile / 10 min).
- `/v1/crm/*` e `/internal/*` respondem `401` ao ZAP (sem token / sem assinatura QStash): é o esperado. Scan
  autenticado do CRM (JWT de staff com AAL2) é trabalho da 9b e exige usuário de teste dedicado.
- Varredura contra **produção** só passiva, fora de horário de pico e com o dono ciente.

## Como a 6b vai executar no CI (não habilitado nesta onda)

Não há workflow nesta onda (decisão do plano: workflow só na 6b). O desenho é um job manual
(`workflow_dispatch`), `permissions: contents: read`, Actions pinadas por SHA, que:

1. recebe a URL do preview como input (validada pelo mesmo regex do `run-zap.sh`) e roda `security/zap/run-zap.sh`
   com `ZAP_IMAGE` pinado por digest;
2. publica `report.html`/`report.json` como artefato de retenção curta;
3. falha o job com o exit code do script. Execução contra alvo remoto exige aprovação de um Environment
   protegido do GitHub (equivalente à confirmação humana).

## Política das regras

- Alterar `zap-rules.tsv` é mudança de segurança: cada `IGNORE` leva justificativa na própria linha e, na 6b,
  a evidência (resposta que provou o falso positivo).
- Um alerta real de severidade Low/Informational não reprova o gate; fica no relatório e no triage do PR.
- Alertas `FAIL` do `.tsv` reprovam mesmo em severidade baixa: são os headers de
  [000 §5.1](../../docs/specs/000-overview.md#51-segurança-baseline-transversal) e a regra de nunca setar
  cookie nem vazar erro interno.
