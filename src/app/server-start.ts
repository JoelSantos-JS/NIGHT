// Sobe o servidor das telas a partir do terminal, da voz ou do `night:servidor`, com a mesma mensagem.
// Falhar aqui não derruba o NIGHT: sem servidor, a voz e o terminal continuam funcionando.
import { DEFAULT_PORT, startNightServer, type NightServer, type ServerDeps } from './server.ts';

export async function startNightServerFor(deps: ServerDeps): Promise<NightServer | null> {
  const port = Number(process.env.NIGHT_PORT ?? DEFAULT_PORT);
  try {
    const s = await startNightServer(deps, { port });
    console.log(`Telas do OpenBot (MCP): ${s.mcpUrl} · painel de decisões: ${s.painelUrl}`);
    return s;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const motivo = e.code === 'EADDRINUSE' ? `a porta ${port} já está em uso (defina NIGHT_PORT para outra)` : e.message;
    console.error(`Aviso: não subi o servidor das telas: ${motivo}.`);
    return null;
  }
}
