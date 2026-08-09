# Serviço protegido de submissão EPE

Este Cloudflare Worker recebe os pedidos do Dashboard ANEPC, valida a origem e a chave de operador e aciona o workflow `atualizar-epe.yml` através de `workflow_dispatch`.

## Configuração

As variáveis públicas estão em `wrangler.toml`. Os seguintes valores são segredos e nunca devem ser gravados no repositório:

- `EPE_OPERATOR_KEY`: chave longa usada pelos postos autorizados;
- `GITHUB_TOKEN`: fine-grained personal access token limitado ao repositório `ANEPCVCT/Dashboard`, com permissão **Actions: Read and write**.

Configuração manual equivalente:

```bash
npx wrangler secret put EPE_OPERATOR_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

O endpoint público para o Dashboard é `POST /epe`. O diagnóstico sem credenciais é `GET /health`, acessível apenas a partir da origem autorizada.

## Segurança

- CORS limitado a `https://anepcvct.github.io`;
- autenticação Bearer com chave guardada apenas na sessão do navegador;
- token GitHub guardado exclusivamente como segredo Cloudflare;
- corpo limitado a 16 KiB;
- validação superficial no Worker e validação integral no processador Python da Action;
- respostas sem cache e sem exposição de detalhes ou credenciais.
