# Dashboard ANEPC protegido

O Cloudflare Worker serve o Dashboard, autentica contas individuais e autoriza cada
operação no servidor. O endereço GitHub Pages deve ser desativado apenas depois de a
versão protegida estar validada.

## Contas e permissões

- `ADMIN principal`: única conta externa a `@prociv.pt`; tem de ser Gmail, recebe todas
  as permissões e não pode ser desativada.
- As restantes contas têm obrigatoriamente o sufixo `@prociv.pt`.
- As permissões são independentes: `Ver Dashboard`, `Gerir EPE` e `Gerir utilizadores`.
- Toda a conta criada ou cuja password seja redefinida fica obrigada a trocar a password
  provisória antes de usar qualquer funcionalidade.

As passwords são derivadas com PBKDF2-HMAC-SHA-256, 600 000 iterações, sal aleatório por
conta e um pepper guardado apenas como segredo do Worker. As sessões usam cookies
`HttpOnly`, `Secure` e `SameSite=Strict`, com proteção CSRF e bloqueio temporário após
tentativas repetidas.

## Persistência

As contas, sessões e auditoria ficam num Durable Object com armazenamento SQLite. A
migração `v1` é criada automaticamente na primeira publicação e não requer uma base D1
separada. A conta gratuita da Cloudflare suporta Durable Objects SQLite.

## Segredos do GitHub Actions

Além dos segredos Cloudflare e GitHub já existentes, o workflow necessita de:

- `DASHBOARD_ROOT_EMAIL`: email Gmail do ADMIN principal;
- `DASHBOARD_ROOT_INITIAL_PASSWORD`: password provisória, exclusiva do Dashboard, com
  pelo menos 12 caracteres;
- `DASHBOARD_PASSWORD_PEPPER`: valor aleatório de pelo menos 32 caracteres, conservado
  permanentemente.

`EPE_OPERATOR_KEY` deixa de ser usado. O token `EPE_GITHUB_TOKEN` continua guardado como
`GITHUB_TOKEN` no Worker para acionar exclusivamente o workflow EPE.

## Publicação

O workflow `.github/workflows/deploy-epe-worker.yml` instala as dependências, executa os
testes, copia apenas os ficheiros públicos necessários para o pacote privado e publica o
Worker paralelo `dashboard-anepc`, sem substituir o Worker EPE antigo durante a fase de
validação. O endpoint público `/health` não contém dados operacionais;
todo o restante conteúdo requer uma sessão autorizada.
