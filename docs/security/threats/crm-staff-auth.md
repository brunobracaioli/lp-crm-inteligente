# Threat model — Autenticação do staff e rotas do CRM (`/v1/crm/*`)

> Data: 2026-11-03 · Método: STRIDE + OWASP API Top 10:2023 · Onda 9a (contrato) → implementação na 9b
> Contrato: [`contracts/openapi.v1.yaml`](../../../contracts/openapi.v1.yaml) `1.0.0-draft.3` · Specs: [crm §7](../../specs/crm.md),
> [database §3.10 e §5](../../specs/database.md), [000 §5](../../specs/000-overview.md) · Complementa [backend-v1](backend-v1.md).
> Revisar ao abrir a 9b (implementação), a 10 (CRM web: CSP, armazenamento de sessão) e a 11b (ações de IA/automação).

## Ativos

| Ativo | Sensibilidade |
|---|---|
| PII de todos os leads, acessível ao staff (nome, e-mail, WhatsApp, empresa, mensagem, notas) | Alta (LGPD) |
| Tokens de staff (access token Supabase, 15 min) e sessões/refresh | Crítica |
| Tabela de membership e papéis (`core.workspace_members`) — define quem pode o quê | Crítica |
| `core.audit_log` e `crm.lead_activities` (prova de quem fez o quê) | Alta |
| Integridade do pipeline (estágios `qualified`/`won` disparam offline conversions para ads) | Média/alta |
| Chaves derivadas de `HASH_PEPPER` (assinatura de cursor e de `plan_hash`) | Alta |
| Disponibilidade do CRM | Média |

## Fronteiras de confiança

1. Browser (CRM web, Onda 10) ↔ Supabase Auth — login, MFA (TOTP), emissão do JWT. Fora desta API.
2. Browser ↔ API `/v1/crm/*` — **autenticada** (`Authorization: Bearer`); o token é a única credencial.
3. API ↔ JWKS do Supabase — GET HTTPS, só da URL configurada; resposta tratada como dado não confiável.
4. API ↔ Postgres como `lp_api` — workspace vem da membership e é aplicado por `set_config` + RLS.
5. API ↔ Redis — rate limit e idempotência (indisponibilidade: fail-open comum, fail-closed em export/DSR).

Nenhuma rota do CRM é pública. Rede/origem **não** é credencial: CORS é só proteção de browser e a allowlist do CRM web é
separada da da LP (ver C45).

## Pressupostos de projeto (dependências de outras ondas)

- Supabase Auth com **cadastro público desligado**, **sign-in anônimo desligado** e **MFA TOTP habilitado** (`supabase/config.toml`, Onda 1).
  Sem TOTP não existe `aal2` e o export fica inalcançável (fail-closed, mas inutilizável).
- Membership provisionada **fora da API** (migration/seed/console do dono); `lp_api` só tem `SELECT` em `core.workspace_members`.
  Não há rota para criar usuários, mudar papéis ou ativar/desativar membros — logo não há escalada de papel via API.
- Chaves de cursor e de `plan_hash` derivadas de `HASH_PEPPER` por HKDF com rótulos distintos (`crm-cursor-v1`, `crm-plan-v1`),
  sem nova variável de ambiente (congelada na Onda 0).

## STRIDE

Legenda de "Imposta em": **contrato** = `contracts/openapi.v1.yaml`; **middleware** = `platform/auth` e guards do Hono;
**domínio** = `modules/crm/domain`/`application`; **RLS/DB** = políticas, grants e funções do Postgres; **front** = CRM web (Onda 10).
Os testes `ST-xx` estão definidos na seção "Testes a escrever na 9b".

### A. Autenticação (Spoofing)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C1 | Token forjado: `alg: none`, HS256 assinado com a chave pública (confusão de algoritmo), ES384/RS512 | Spoofing | Allowlist fixa {ES256, RS256} no servidor; chave escolhida por `kid` no JWKS com `kty` compatível; `jwtVerify({ algorithms })` | middleware; contrato (`staffBearer`) | ST-01 |
| C2 | Token legítimo de outro emissor/projeto, de `anon`/`service_role` legado ou de conta anônima | Spoofing | `iss` idêntico a `SUPABASE_JWT_ISSUER`; `aud = authenticated`; `role = authenticated`; `is_anonymous ≠ true`; `sub` UUID | middleware | ST-02 |
| C3 | Token expirado ou ainda não válido; token com validade anormal por erro de configuração | Spoofing | `exp`/`nbf` com tolerância ≤ 5 s; `exp − iat ≤ 3600 s` como sanidade; access token de 15 min (`jwt_expiry = 900`) | middleware | ST-03 |
| C4 | Descoberta de chave controlada pelo atacante (`jku`, `jwk`, `x5u`, `kid` hostil) e SSRF/DoS via JWKS | Spoofing / DoS | JWKS só de `SUPABASE_JWKS_URL` (https, config); headers de descoberta do token ignorados; resposta validada; timeout 3 s; cache com cooldown de refetch para `kid` desconhecido | middleware | ST-04 |
| C5 | Falha do JWKS vira bypass (fail-open) ou derruba o CRM | Spoofing / DoS | Fail-closed: sem chave válida em cache → `503`, nunca aceita sem verificar; com cache válido segue operando | middleware; contrato (`503`) | ST-05 |
| C6 | Token em query string, cookie, log ou `Referer` | Information disclosure | Só `Authorization: Bearer`; o logger já redige `authorization`; nada de token em URL | middleware; contrato | ST-06, ST-30 |
| C7 | Roubo de token (XSS no CRM web, extensão, malware) e uso por até 15 min | Spoofing / EoP | TTL 15 min; ações destrutivas/exfiltração exigem MFA ≤ 300 s (C11); membership relida a cada requisição (desativar um membro corta o acesso na próxima chamada); CSP e ausência de `dangerouslySetInnerHTML` no CRM web | middleware; front (Onda 10) | ST-08; e2e da Onda 10 |
| C8 | Quem cria conta no Supabase Auth (signup aberto, sign-in anônimo) tenta usar o JWT | Spoofing / EoP | Autorização por membership (deny by default); signup/anon desligados na config; todas as rotas devolvem `403` sem membership ativa | middleware; RLS/DB; config | ST-08, ST-37 |
| C9 | Resposta de `401` revela o motivo (enumeração de chaves, contas, versões) | Information disclosure | `401` genérico, mesmo corpo e headers para qualquer falha, com `WWW-Authenticate: Bearer` sem detalhe | middleware; contrato (`StaffUnauthorized`) | ST-07 |

### B. MFA e reautenticação (AAL2)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C10 | Senha vazada de um admin permite exportar/anonimizar sem segundo fator | Spoofing / EoP | `x-requires-aal2`: `aal = aal2` e `amr` com método MFA; senão `403 mfa_required` | middleware; contrato | ST-17 |
| C11 | Sessão AAL2 antiga reaproveitada (máquina destravada, token roubado minutos depois) | Spoofing | `x-max-auth-age-seconds = 300` sobre a verificação MFA mais recente (`amr[].timestamp`) no export e na **aplicação** da anonimização → `403 reauthentication_required`; step-up e retry | middleware; contrato | ST-17 |
| C12 | Forja ou downgrade de `aal`/`amr`; `aal2` declarado sem MFA real | Tampering | Claims só são lidos após a verificação de assinatura; `aal2` sem entrada MFA em `amr` é negado; relógio injetável nos testes (sem `sleep`) | middleware | ST-17 |
| C13 | Quem não pode exportar recebe dica de MFA (e tenta contornar) | Information disclosure | Ordem fixa: papel (`forbidden`) antes de AAL2 (`mfa_required`) antes da idade (`reauthentication_required`) | middleware; contrato (`staffBearer`) | ST-13, ST-18 |

### C. Autorização (BOLA / BFLA / tenant)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C14 | **BOLA cross-tenant** (AC-CRM-06): ler/alterar lead de outro workspace por `id` | Information disclosure / EoP | Workspace só da membership do `sub`, nunca de parâmetro (o contrato nem tem o parâmetro); `set_config('app.workspace_id')` por transação + RLS `FORCE` + filtro explícito no repositório; inexistente e de outro workspace → `404` idêntico | middleware; domínio; RLS/DB; contrato | ST-14, ST-15, ST-16 |
| C15 | BOLA intra-workspace: `sales` altera lead de outro dono; `viewer` muta | EoP | Papel na allowlist `x-roles` + regra por recurso no caso de uso (`sales` só em lead seu ou sem dono; reabrir `lost` só `owner`/`admin`) — nunca só na UI | middleware; domínio; contrato (`x-role-conditions`) | ST-10, ST-11 |
| C16 | BFLA / escalada de papel: `sales` chama owner/export/DSR; papel lido de claim editável pelo usuário | EoP | Papel só de `core.workspace_members` (nunca `app_metadata`/`user_metadata`); sem rotas de gestão de membros; `lp_api` somente `SELECT` na tabela | middleware; RLS/DB | ST-09, ST-10, ST-38 |
| C17 | Mass assignment: `workspace_id`, `role`, `score`, `stage` em nota, `owner_user_id` no PATCH de estágio | Tampering | Corpos `additionalProperties: false` (Zod `.strict()`); query desconhecida → `400`; DTOs sem esses campos | contrato; middleware | ST-12 |
| C18 | Corrida: dois PATCH com a mesma `version`; papel rebaixado entre a checagem e a escrita | Tampering / EoP | `UPDATE … WHERE id AND version = $n` atômico (`409 version_conflict`); membership relida na mesma transação da mutação | domínio; RLS/DB | ST-22, ST-08 |
| C19 | Atribuir dono inexistente ou de outro workspace | EoP | Alvo validado contra membros ativos do workspace da credencial; erro `400` sem distinguir os casos | domínio; contrato | ST-14 |
| C20 | Cursor forjado ou reaproveitado (IDOR por paginação, injeção na chave de ordenação) | Tampering | Cursor assinado (HMAC) sobre workspace + usuário + filtros + chave de ordenação; chaves revalidadas (UUID/timestamp) e parametrizadas; inválido → `400` | middleware; domínio | ST-34 |

### D. Injeção e conteúdo (Tampering)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C21 | **CSV/formula injection** no export (T7 do backend-v1) | Tampering | TODA célula de texto começando (após espaços) por `= + - @ TAB CR` recebe `'`; quoting RFC 4180; export sem mensagem, notas, IP/UA nem click IDs. Efeito colateral aceito: o WhatsApp (`+55…`) sai como `'+55…` | contrato (descrição do export); domínio | ST-19 |
| C22 | XSS armazenado: nota/nome/mensagem com marcação executa no CRM | Tampering / EoP | Entrada: pipeline Unicode (sem `\p{Cc}`/`\p{Cf}`); saída: JSON com `nosniff`, escape no React, sem `dangerouslySetInnerHTML`, CSP sem `unsafe-inline`/`unsafe-eval`; textos marcados como não confiáveis no contrato | contrato; front (Onda 10) | ST-39; e2e da Onda 10 |
| C23 | Trojan Source/bidi em nota para enganar outro vendedor | Spoofing | Pipeline rejeita `\p{Cf}`, controles, surrogates soltos e `U+FFFD` (`not_allowed_characters`) | domínio; contrato | ST-39 |
| C24 | SQL injection por `q`, filtros, cursor ou nota; curingas de LIKE (`%`, `_`) como oráculo/DoS | Tampering | Só queries parametrizadas; `q` tratado como prefixo literal (escape de `%_\` ou `starts_with`); Semgrep bloqueia `sql.unsafe`; role sem DDL/DELETE | domínio; RLS/DB | ST-33 |
| C25 | Header injection em `Content-Disposition` | Tampering | Nome de arquivo gerado pelo servidor (data ou UUID), nunca derivado de dado do lead | contrato (pattern do header) | ST-20, ST-27 |

### E. Não repúdio (Repudiation)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C26 | Staff nega ter exportado, reatribuído, anotado ou anonimizado | Repudiation | `core.audit_log` append-only (`x-audit-action`): ator = `sub` (imutável, não e-mail), workspace, ação, recurso, resultado, `correlation_id`; gravado **na mesma transação** da mutação; negações (`denied`) gravadas fora da transação revertida | domínio; RLS/DB (AC-DB-05) | ST-29, ST-21 |
| C27 | Reescrita da linha do tempo do lead | Repudiation / Tampering | `crm.lead_activities` append-only com `actor_type`/`actor_id` | RLS/DB | ST-29 |
| C28 | Mutação sem rastro por falha parcial (audit fora da transação) | Repudiation | Mutação e audit atômicos; se o audit falha, a mutação é revertida (`500`) | domínio | ST-29 |

### F. Vazamento de informação (Information disclosure)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C29 | **Exfiltração via export CSV** | Information disclosure | Só `owner`/`admin`; AAL2 + MFA ≤ 300 s; 5/h por usuário **fail-closed**; 1 export simultâneo por usuário; teto de 10 000 linhas com `X-Export-Truncated`; filtros para minimizar; audit com nº de linhas; alerta de volume anômalo | contrato; middleware; domínio | ST-17, ST-20, ST-21 |
| C30 | **Leitura em massa pela listagem/busca** (qualquer papel: 120 req/min × 100 itens) contorna o limite do export | Information disclosure | Mitigação parcial: payload mínimo na lista (sem WhatsApp, mensagem, IP/UA, atribuição); métrica `crm.rows_read{user}` + alerta; cota diária proposta (decisão G11). **Risco residual R3** | contrato; middleware | ST-32 |
| C31 | PII em query string e, portanto, em logs de acesso da plataforma (busca por e-mail via `GET ?q=`) | Information disclosure | `q` só no corpo de `POST /v1/crm/leads/search`; `GET /v1/crm/leads` não tem `q` e rejeita parâmetros desconhecidos; logger não registra corpo nem query | contrato; middleware | ST-33, ST-30 |
| C32 | Vazamento de existência/estrutura: `403` vs `404`, mensagens detalhadas, listagem de usuários | Information disclosure | `404` uniforme; `401` genérico; `problem+json` sem eco de valores; `GET /v1/crm/members` sem e-mail e só do próprio workspace | contrato; middleware | ST-31 |
| C33 | Cache de browser/proxy retém PII | Information disclosure | `Cache-Control: no-store` e demais headers de segurança em todas as respostas, inclusive 401/403/429 e o CSV | middleware (`http-security`) | ST-36 |
| C34 | Pedido de acesso do titular feito por impostor (engenharia social) | Spoofing / Information disclosure | A API só entrega a `owner`/`admin` com AAL2 e audita; **verificação de identidade do titular é processo humano**, fora da API; sem envio automático por e-mail. **Risco residual R4** | processo; contrato | ST-27 |
| C35 | Dados remanescentes após anonimizar (notas, `first_touch`/`last_touch`, payloads, IP/UA) | Information disclosure (LGPD) | Preview lista as categorias que serão apagadas; `crm.anonymize_lead` deve cobrir notas e atribuição (lacuna G4); teste varre o banco atrás do e-mail, nome, telefone e texto originais | RLS/DB (Onda 6b); contrato | ST-25, ST-28 |
| C36 | PII já enviada (hash) a Meta/Google não pode ser recolhida | Information disclosure (LGPD) | Documentado no contrato e no preview; **risco residual R5** | processo | — |

### G. Negação de serviço (DoS)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C37 | Flood de tokens inválidos (custo de verificação, refetch de JWKS) | DoS | Rate limit por IP **antes** da verificação do JWT; `kid` desconhecido não gera fetch por requisição (cooldown); Vercel Firewall | middleware | ST-32, ST-04 |
| C38 | Usuário autenticado abusivo (scraping, loops de escrita) | DoS | 120 req/min leitura e 30 req/min escrita por usuário, `429` + `Retry-After`; export 5/h; fail-open nas rotas comuns, **fail-closed** em export/data-export/anonimização | middleware; contrato (`x-rate-limit`) | ST-32, ST-21 |
| C39 | Consulta cara: `limit` enorme, `q` curto, curingas, ordenação sem índice, export grande | DoS | `limit ≤ 100`; `q` de 2–80 caracteres e só prefixo; índices do database §3.3 + índice de prefixo para `q` (9b); `statement_timeout` 3 s; export por keyset com teto | contrato; domínio; RLS/DB | ST-33, ST-20 |
| C40 | Corpo gigante ou JSON profundo | DoS | Corpo ≤ 16 KB antes do parse; schemas com `maxLength`/`maxItems` (a nota de 5 000 caracteres pode passar de 16 KB em UTF-8: lacuna G5) | middleware; contrato | ST-33 |

### H. Elevação de privilégio (EoP)

| # | Ameaça | Categoria | Mitigação | Imposta em | Teste |
|---|---|---|---|---|---|
| C41 | SQLi/bug na API expõe outros workspaces | EoP | `lp_api` sem `BYPASSRLS`, RLS `ENABLE`+`FORCE`, sem DDL/DELETE (herdado de AC-DB-01..04) | RLS/DB | ST-15 |
| C42 | Staff usa o próprio JWT direto na Data API do Supabase para ler tabelas | EoP | Schemas fora da Data API e `authenticated` sem `USAGE` (AC-DB-01, AC-DB-10); `core.workspace_members` idem | RLS/DB | ST-38 |
| C43 | Chave `service_role`/secret do Supabase no runtime da API | EoP | Proibido (backend-v1 T15); a API conecta só como `lp_api`; gitleaks | config; CI | — |
| C44 | Anonimização usada para sabotagem (apagar o pipeline) por conta comprometida ou insider | Tampering (disponibilidade de dados) | AAL2 + MFA ≤ 300 s na aplicação, preview com `plan_hash` ligado a usuário + lead + `version`, audit, alerta de picos; cota dedicada mais baixa proposta (decisão G12) | contrato; domínio | ST-26 |
| C45 | Página da LP (origem na allowlist pública) chama `/v1/crm/*` do browser da vítima | Spoofing | Sem cookies (Bearer em header) → CORS não é a defesa, mas a allowlist das rotas do CRM é **só a origem do CRM web**, sem `Allow-Credentials` | middleware (`http-security`) | ST-36 |

## OWASP API Security Top 10:2023

| Item | Como se aplica | Onde / teste |
|---|---|---|
| API1 BOLA | Todo `{id}` resolvido dentro do workspace da credencial; `404` uniforme; cursor assinado | C14, C20 · ST-14, ST-34 |
| API2 Broken Authentication | JWT/JWKS rígido, `401` genérico, MFA para ações sensíveis, sem token em URL | C1–C13 · ST-01..07, ST-17 |
| API3 Broken Object Property Level Authorization | Corpos estritos; respostas com campos mínimos (lista sem WhatsApp/IP/UA; detalhe sem identificadores de rastreamento) | C17, C30 · ST-12 |
| API4 Unrestricted Resource Consumption | Limites por usuário, `limit ≤ 100`, teto de export, timeouts, corpo ≤ 16 KB | C37–C40 · ST-32, ST-33 |
| API5 Broken Function Level Authorization | `x-roles` por operação + regras por recurso; sem rota de gestão de membros | C15, C16 · ST-10 |
| API6 Unrestricted Access to Sensitive Business Flows | Export, DSR e reatribuição: papel + AAL2 + cota + audit + preview/`plan_hash` | C29, C44 · ST-21, ST-26 |
| API7 SSRF | Nenhuma URL fornecida pelo usuário é buscada; `company_website` nunca é acessado; único fetch de saída é o JWKS configurado | C4 · ST-04 |
| API8 Security Misconfiguration | Headers em todas as respostas, CORS separado para o CRM web, signup/anon desligados, TOTP ligado | C8, C33, C45 · ST-36, ST-37 |
| API9 Improper Inventory Management | O contrato é o inventário: teste de drift roteador ↔ OpenAPI e `x-roles` ↔ middleware | ST-35 |
| API10 Unsafe Consumption of APIs | Resposta do JWKS validada antes do uso; claims do JWT tratados como não confiáveis até a assinatura | C4, C5 · ST-05 |

## Matriz de autorização a testar (ST-10)

Cada linha vira testes nos três estados do lead (do próprio usuário, de outro dono, sem dono) e com os quatro papéis, mais "sem membership" e "membro inativo".

| Operação | owner | admin | sales | viewer | Extra |
|---|---|---|---|---|---|
| `GET /v1/crm/me`, `GET /v1/crm/members` | sim | sim | sim | sim | — |
| `GET /v1/crm/leads`, `POST /v1/crm/leads/search`, `GET /v1/crm/leads/{id}` | sim | sim | sim | sim | — |
| `PATCH /v1/crm/leads/{id}/stage` | sim | sim | só lead seu ou sem dono (atribui ao próprio) | `403` | reabrir `lost`: só owner/admin |
| `PATCH /v1/crm/leads/{id}/owner` | sim | sim | `403` | `403` | alvo = membro ativo do workspace |
| `POST /v1/crm/leads/{id}/notes` | sim | sim | só lead seu ou sem dono (não atribui) | `403` | `Idempotency-Key` obrigatório |
| `GET /v1/crm/leads/export.csv` | sim | sim | `403` | `403` | AAL2 + MFA ≤ 300 s; 5/h |
| `GET /v1/crm/leads/{id}/data-export` | sim | sim | `403` | `403` | AAL2 |
| `POST /v1/crm/leads/{id}/anonymize` | sim | sim | `403` | `403` | AAL2; MFA ≤ 300 s na aplicação; `plan_hash` |

## Testes a escrever na 9b

Princípios: determinísticos (relógio injetável, sem `sleep`), JWKS e Redis falsos (MSW/fakes), banco real (`supabase start`) para tudo que depende de RLS.
Chaves de teste ES256/RS256 geradas no setup do teste — nenhum segredo no repositório.

| ID | Prova |
|---|---|
| ST-01 | `alg: none`, HS256 assinado com a chave pública, ES384 e RS512 → `401` |
| ST-02 | `iss` errado, `aud` errado, `role: service_role`/`anon`, `is_anonymous: true`, `sub` não UUID → `401` |
| ST-03 | Expirado, `nbf` futuro, tolerância > 5 s, `exp − iat > 3600` → `401` |
| ST-04 | `jku`/`jwk`/`x5u` no header não geram requisição (MSW afirma zero chamadas); `kid` desconhecido repetido → no máximo 1 refetch por cooldown |
| ST-05 | JWKS fora do ar sem cache → `503`; com cache válido → atende; JWKS malformado → `503` |
| ST-06 | `?access_token=` e cookie são ignorados (`401`); varredura de logs não encontra o token |
| ST-07 | Header ausente, duplicado, `Basic`, bearer vazio → `401` com `WWW-Authenticate: Bearer` e corpo idêntico em todos os motivos |
| ST-08 | JWT válido sem membership → `403` em **todas** as rotas; membro `active = false` → `403` com o mesmo token na requisição seguinte |
| ST-09 | `app_metadata.role`/`user_metadata.role` = `owner` com papel real `viewer` → comporta-se como `viewer` |
| ST-10 | Matriz papel × rota × propriedade do lead acima, com status esperado em cada célula |
| ST-11 | `sales` não reabre `lost`; `sales` em lead sem dono muda estágio e vira dono (decisão G6) |
| ST-12 | Chaves extras (`workspace_id`, `role`, `version`, `score`, `stage` em nota, `owner_user_id` no estágio) → `400`; `?workspace_id=` → `400` |
| ST-13 | Corpo inválido sem token → `401`; `viewer` no export → `403 forbidden` (não `mfa_required`); corpo inválido em lead de outro workspace → `404` |
| ST-14 | **AC-CRM-06** com dois workspaces: todas as rotas com `{id}` → `404`; lista/busca/export/members só veem o próprio workspace; dono de outro workspace → `400` |
| ST-15 | Com o filtro de workspace removido do repositório, `lp_api` ainda enxerga 0 linhas de outro workspace (RLS como segunda barreira) |
| ST-16 | Requisições concorrentes de workspaces A e B no mesmo pool nunca misturam dados (`set_config` por transação) |
| ST-17 | **AC-CRM-07**: `aal1` → `403 mfa_required`; `aal2` com `amr` velho → `403 reauthentication_required` (export e aplicação do anonymize); `aal2` recente → ok; `aal2` sem MFA em `amr` → negado |
| ST-18 | `sales`/`viewer` nas rotas AAL2 → `403 forbidden` (papel antes de MFA) |
| ST-19 | Propriedade (fast-check): nenhuma célula de saída começa por `= + - @ TAB CR` (nem após espaços); `=1+1` → `'=1+1`; ida-e-volta por parser CSV recupera o valor; aspas, vírgulas e CRLF preservados; numéricas intactas |
| ST-20 | Teto de 10 000 + `X-Export-Truncated`; `Content-Disposition` fixo; sem colunas de IP/UA/mensagem/click ID; anonimizados marcados |
| ST-21 | Audit do export (ator, nº de linhas, chaves dos filtros, sem PII) inclusive negado; 2º export simultâneo → `429`; 6º na hora → `429` com `Retry-After`; Redis fora → `503` em export, data-export e anonymize |
| ST-22 | **AC-CRM-08**: `expected_version` velha → `409 version_conflict` sem mudar lead, atividade nem outbox; dois PATCH paralelos com a mesma versão → exatamente um vence |
| ST-23 | Tabela com todas as transições de crm §4 via HTTP (permitidas `200`, proibidas `422`); `to_stage = new` → `400`; `lost` sem motivo → `400`; motivo com destino ≠ `lost` → `400` |
| ST-24 | Idempotência: repetir chave + corpo → mesma resposta com 1 atividade e 1 evento de outbox; mesma chave + corpo diferente → `422`; concorrente → `409` + `Retry-After`; chave de outro usuário não repete resposta; nota sem chave → `400` |
| ST-25 | **AC-CRM-09**: sem `confirm` nada muda (snapshot do banco idêntico) e devolve `plan_hash`; com `confirm` + hash, PII some (varredura no banco) e o e-mail volta a ser um lead novo; 2ª aplicação → `409 lead_anonymized` |
| ST-26 | `plan_hash` de outro lead, de outro admin, após mudança de `version`, expirado ou adulterado → `409 plan_stale`; `confirm: true` sem hash → `400` |
| ST-27 | `data-export` traz tudo (e só) daquele lead, inclusive IP/UA ainda retidos; anonimizado → `409`; audit; `attachment` + `no-store` |
| ST-28 | Após anonimizar: IDs, estágio, score, datas e consentimentos preservados; atividade `anonymized` e audit gravados; corpo de notas e atribuição sem o dado original |
| ST-29 | Cada mutação gera exatamente 1 linha de audit na mesma transação; mutação que falha reverte as duas; negação de papel/MFA gera audit `denied` |
| ST-30 | Varredura final de logs, métricas e metadados de audit: sem e-mail, WhatsApp, nome, texto de nota, bearer, `plan_hash` nem cursor (extensão de AC-LC-17) |
| ST-31 | Respostas de erro só `problem+json` sem stack/SQL; `404` de id inexistente e de outro workspace têm corpo e headers idênticos |
| ST-32 | 121ª leitura/min e 31ª escrita/min → `429` + `Retry-After`, por usuário (outro usuário não é afetado); limiter por IP age antes da verificação do JWT |
| ST-33 | `limit > 100`, `q` com 1 ou > 80 caracteres, parâmetro desconhecido → `400`; `%` e `_` em `q` são literais; corpo > 16 KB → `413`; nota no limite de 5 000 caracteres conforme decisão G5 |
| ST-34 | Ordem estável com `created_at` empatado (desempate por `id`); sem duplicata nem salto entre páginas com inserções concorrentes; cursor de outro usuário/filtro/adulterado → `400` |
| ST-35 | Drift: rotas `/v1/crm/*` registradas no Hono = paths do contrato (nos dois sentidos); toda operação tem `security: staffBearer` e `x-roles` não vazio; o papel exigido pelo middleware = `x-roles`; respostas validadas contra o OpenAPI |
| ST-36 | Preflight da origem da LP em `/v1/crm/*` → recusado; origem do CRM web → métodos e headers esperados (`Authorization`, `Content-Type`, `Idempotency-Key`, `X-Request-Id`), sem `Allow-Credentials`; headers de segurança e `no-store` em 401/403/429 |
| ST-37 | Verificação estática de `supabase/config.toml`: signup desligado, sign-in anônimo desligado, TOTP habilitado, `jwt_expiry = 900` |
| ST-38 | pgTAP: `core.workspace_members` com RLS `ENABLE`+`FORCE`; `lp_api` só `SELECT`; `anon`/`authenticated` sem acesso; PK `(workspace_id, user_id)` |
| ST-39 | Nota com `<script>`/`<img onerror>` é guardada e devolvida literalmente em JSON (`nosniff`); bidi/`\p{Cf}`/controles → `400 not_allowed_characters` |

## Riscos residuais aceitos

| # | Risco | Justificativa / compensação | Revisão |
|---|---|---|---|
| R1 | Token roubado vale até 15 min (e ações sensíveis até 5 min após o MFA) | Bearer é por natureza replayável; TTL curto + MFA recente + membership por requisição + CSP no CRM web | Onda 10 |
| R2 | `owner`/`admin` sem MFA cadastrado usa funções de admin não sensíveis (ex.: `PATCH owner`) | A spec só exige AAL2 em export/DSR; MFA obrigatório no login do admin é requisito da Onda 10. Alternativa: exigir AAL2 em toda rota de `owner`/`admin` (decisão G13) | 9b |
| R3 | Leitura em massa pela listagem (qualquer papel) | Dado necessário ao trabalho do vendedor; detecção por métrica/alerta, não bloqueio | após 30 dias de dados |
| R4 | Titular falso em pedido LGPD | Identidade verificada por humano fora da API; AAL2 + audit | processo |
| R5 | Dados já enviados (hash) a Meta/Google não são recolhíveis | Limite da plataforma; informado no preview | — |
| R6 | Supabase Auth é ponto único de identidade (queda = staff sem acesso; comprometimento emite tokens válidos) | Sem membership o token não opera; fail-closed no JWKS; membership gerida fora do IdP | trimestral |
| R7 | `owner`/`admin` legítimo com MFA fresca exporta até 5 × 10 000 linhas por hora | Audit + alerta; ver C29 | após 30 dias de dados |

## Lacunas de spec e decisões abertas (para a sessão principal / dono)

Este documento não altera specs. O contrato da 9a adotou o default indicado; cada item pode ser revertido com mudança local no OpenAPI.

| # | Lacuna ou conflito | Escolha no contrato (draft.3) |
|---|---|---|
| G1 | crm §7 põe `q` (e-mail/nome) em query string; `CLAUDE.md` proíbe PII em query string (logs de acesso da plataforma) | `GET /v1/crm/leads` sem `q`; busca em `POST /v1/crm/leads/search` (corpo). Rota adicional à spec |
| G2 | Não há como resolver o nome do dono nem listar quem pode ser dono; `core.workspace_members` não tem nome | `GET /v1/crm/members` (rota adicional); exige coluna `display_name` na migration da 9b (database §3.10) |
| G3 | crm §7 cita `auth_time`; o Supabase não emite esse claim | Idade = último `amr[].timestamp` de método MFA; ajustar o texto da spec |
| G4 | `crm.anonymize_lead` (database §6) não menciona corpo de notas (`lead_activities` é append-only), `first_touch`/`last_touch` nem `message` em atividades | Preview lista `activity_notes` e `attribution_snapshots`; a 6b precisa confirmar que a função cobre isso |
| G5 | Nota de 5 000 caracteres (até ~20 KB em UTF-8) excede o corpo máximo de 16 KB | Contrato mantém 5 000 e `413`; decidir: elevar o limite só em `/notes` ou limitar por bytes |
| G6 | "Auto-atribuição" e colisão de nome: papel `owner` do workspace × dono do lead (`owner_user_id`) | `sales` que muda o estágio de lead sem dono vira o dono; nota não atribui. Confirmar |
| G7 | Contrato mais estrito que a spec | AAL2 + MFA ≤ 300 s também na **aplicação** do anonymize; neutralização de CSV ignora espaços à esquerda; export com teto de 10 000 linhas, filtros e 1 simultâneo; `q` ≥ 2; `limit` padrão 25; query desconhecida → `400` |
| G8 | Origem do CRM web ≠ origem da LP (CORS por grupo de rotas) | Requer allowlist própria (`CRM_WEB_ORIGINS` ou equivalente) em `platform/config` na 9b |
| G9 | `supabase/config.toml` precisa de signup/anon desligados e TOTP ligado | Pressuposto; verificado por ST-37 (Onda 1 é a dona do arquivo) |
| G10 | Chaves de cursor e `plan_hash` | Derivar de `HASH_PEPPER` por HKDF (sem nova env var); rotacionar o pepper invalida cursores e planos (inofensivo) |
| G11 | Listagem permite leitura em massa por qualquer papel, esvaziando o limite de 5/h do export | Sem cota no contrato; propor métrica + alerta e cota diária de linhas lidas por usuário |
| G12 | Anonimização usa o bucket de escrita (30/min) | Propor cota dedicada (ex.: 10 aplicações/h por usuário), fail-closed — valor a definir |
| G13 | MFA só é exigido nas 3 rotas sensíveis | Decidir se `owner`/`admin` precisam de AAL2 em toda rota de admin (ex.: `PATCH owner`) |
| G14 | Conteúdo da exportação do titular (spec: "JSON") | Inclui IP/UA ainda retidos, histórico de consentimento, atribuição completa e notas |
| G15 | Rate limit fail-open/fail-closed em rotas de staff (spec só trata a captura pública) | Fail-open em leitura/escrita comuns; fail-closed em export/data-export/anonymize |
| G16 | `expected_version` no corpo (spec) × `If-Match` | Contrato segue a spec (`expected_version`); sem `If-Match` |
| G17 | A spec não tem rota de atividades; "atividades paginadas" no detalhe | Paginação por `activities_limit`/`activities_cursor` no detalhe; alternativa: `GET /v1/crm/leads/{id}/activities` |
| G18 | `viewer` pode ser escolhido como dono (spec: "membro ativo") | Aceito pelo contrato; considerar restringir a `owner`/`admin`/`sales` |
| G19 | `ProblemCode`/`TITLES` em `apps/api/src/platform/errors/problem.ts` espelham `Problem.code` | Na 9b, acrescentar os 7 códigos novos (a 9a não toca código) |
