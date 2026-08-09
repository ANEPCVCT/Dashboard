# Serviço protegido de submissão EPE

Este Cloudflare Worker recebe os pedidos do Dashboard ANEPC, valida a origem e a chave de operador e aciona o workflow `atualizar-epe.yml` através de `workflow_dispatch`.

## Implantação protegida pelo GitHub Actions

O workflow `.github/workflows/deploy-epe-worker.yml` testa e publica o Worker sem gravar credenciais no repositório. Antes da primeira execução, devem existir estes **Repository secrets**:

- `CLOUDFLARE_ACCOUNT_ID`: identificador da conta Cloudflare onde o Worker será criado;
- `CLOUDFLARE_API_TOKEN`: token Cloudflare limitado à edição de Workers nessa conta;
- `EPE_OPERATOR_KEY`: chave longa e exclusiva usada pelos postos autorizados;
- `EPE_GITHUB_TOKEN`: fine-grained personal access token limitado ao repositório `ANEPCVCT/Dashboard`, com permissão **Actions: Read and write**.

Depois de configurados, executar manualmente o workflow **Deploy EPE Worker**. A Action valida a presença dos quatro segredos, corre os testes e publica `dashboard-anepc-epe` com `EPE_OPERATOR_KEY` e `GITHUB_TOKEN` guardados como segredos do Worker.

## Configuração manual equivalente

As variáveis públicas estão em `wrangler.toml`. Para uma implantação manual, os dois valores consumidos pelo Worker devem ser configurados como segredos e nunca gravados no repositório:

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
