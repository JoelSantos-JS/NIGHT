# Governança de publicação — Instagram, Facebook, TikTok e YouTube

## Integração preferida
O conector Upload-Post MCP declara suporte a TikTok, Instagram, Facebook e YouTube. Verificar **as ferramentas expostas na versão instalada** e suas permissões; não presumir nome de método nem argumentos. Outra via: APIs oficiais diretas, com OAuth e revisão de app quando exigida.

## Pré-condições por rede
- Instagram: conta profissional compatível, credenciais/escopos corretos, mídia hospedada/acessível como exigido pelo provedor.
- Facebook: Página administrada pelo usuário e permissões válidas para Reels; publicar em Página, não presumir perfil pessoal.
- TikTok: conta autorizada; Direct Post exige escopos e pode exigir auditoria para publicar publicamente. Respeitar opções de visibilidade e limites específicos.
- YouTube: canal autenticado via OAuth, API `videos.insert` quando direta, limites de quota e política vigente de Shorts. Upload não garante classificação como Short nem alcance.

## Política operacional
- Conectar contas somente com o titular autenticando pelo fluxo autorizado. Nunca pedir senha do site ao modelo ou guardar tokens em Markdown.
- Manter `publication_enabled=false` até que `connection_test=passed`, `qa=passed`, `approval=granted` (ou opt-in explícito em modo autônomo) e limites de frequência sejam definidos.
- Mostrar prévia, título, descrição, hashtags, música, conta destino, público/privacidade e horário antes da primeira publicação.
- `publish_manifest.json` contém destinos, copy, arquivo, checksum e chave idempotente; nunca declarar sucesso antecipado.
- Registrar `provider_post_id`, URL pública (se fornecida), timestamp e status retornado. Se a API retornar processamento pendente, manter `PROCESSING` e consultar status até prazo máximo.
- Não tentar criar contas ou Páginas por automação não autorizada nem driblar desafios de segurança/CAPTCHA.
- Evitar spam: diversificar conteúdo, respeitar limites e impedir reenvio duplicado.
- Se provedor externo gerencia as credenciais, revisar política de privacidade, limites, custos e retenção antes de conectar.
