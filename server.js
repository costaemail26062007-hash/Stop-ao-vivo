// Servidor do STOP ao vivo.
// Faz 3 coisas: entrega a página do jogo, escuta o chat da live do TikTok
// e repassa os comentários para a página em tempo real.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pasta = path.dirname(fileURLToPath(import.meta.url));
const PORTA = process.env.PORT || 3000;

// Se quiser, coloque o @ da sua conta aqui (sem o @) ou na variável TIKTOK_USER.
// Também dá pra digitar o @ depois, na página /painel.
let usuarioAtual = (process.env.TIKTOK_USER || "").replace(/^@/, "").trim();

const clientes = new Set();
let ultimoStatus = "Servidor ligado. Digite o @ da live em /painel";
let conexao = null;
let timerNovaTentativa = null;

function enviar(obj) {
  const linha = "data: " + JSON.stringify(obj) + "\n\n";
  for (const resp of clientes) resp.write(linha);
}
function status(texto) {
  ultimoStatus = texto;
  console.log("[status]", texto);
  enviar({ tipo: "status", texto });
}
function agendarNovaTentativa() {
  clearTimeout(timerNovaTentativa);
  timerNovaTentativa = setTimeout(iniciar, 10000);
}

// Tira da mensagem do TikTok o @, o nome de exibição e a foto de perfil.
// Tenta os formatos da versão nova e da antiga da biblioteca.
function perfil(d) {
  const u = d?.user ?? d ?? {};
  const usuario = u.uniqueId ?? d?.uniqueId;
  const nome = u.nickname ?? d?.nickname ?? usuario;
  const pp = u.profilePicture ?? d?.profilePicture;
  const foto =
    pp?.url ??
    (Array.isArray(pp?.urls) ? pp.urls[0] : undefined) ??
    (Array.isArray(pp) ? pp[0] : undefined) ??
    u.profilePictureUrl ?? d?.profilePictureUrl;
  return { usuario, nome, foto: typeof foto === "string" ? foto : undefined };
}

async function iniciar() {
  clearTimeout(timerNovaTentativa);
  const velha = conexao;
  conexao = null;
  if (velha) { try { velha.disconnect(); } catch { /* ignora */ } }
  if (!usuarioAtual) { status("Servidor ligado. Digite o @ da live em /painel"); return; }

  let lib;
  try { lib = await import("tiktok-live-connector"); }
  catch { status("Biblioteca do TikTok não instalada (rode npm install)"); return; }

  // Funciona com a versão nova (TikTokLiveConnection) e a antiga (WebcastPushConnection).
  const Conexao = lib.TikTokLiveConnection ?? lib.WebcastPushConnection;
  const EV = lib.WebcastEvent ?? {};
  const CT = lib.ControlEvent ?? {};
  const c = new Conexao(usuarioAtual);
  conexao = c;

  c.on(EV.CHAT ?? "chat", (d) => {
    const p = perfil(d);
    const texto = d?.comment;
    if (p.usuario && texto) enviar({ tipo: "chat", ...p, texto: String(texto) });
  });
  c.on(EV.MEMBER ?? "member", (d) => {
    const p = perfil(d);
    if (p.usuario) enviar({ tipo: "entrou", ...p });
  });
  c.on(EV.STREAM_END ?? "streamEnd", () => status("A live terminou"));
  c.on(CT.DISCONNECTED ?? "disconnected", () => {
    if (conexao === c) { status("Desconectou da live. Tentando de novo..."); agendarNovaTentativa(); }
  });

  status("Procurando a live de @" + usuarioAtual + "...");
  try {
    await c.connect();
    status("Conectado à live de @" + usuarioAtual);
  } catch (erro) {
    console.error("[erro]", erro?.message ?? erro);
    if (conexao === c) {
      status("Live de @" + usuarioAtual + " não encontrada (está no ar?). Tentando de novo...");
      agendarNovaTentativa();
    }
  }
}

const escapar = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

function paginaPainel() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel do Stop</title>
<style>body{font-family:system-ui,sans-serif;background:#1b3ad6;color:#fff;margin:0;padding:24px;max-width:460px;margin:auto}
input,button{font:inherit;padding:12px;border-radius:8px;border:0;width:100%;box-sizing:border-box;margin-top:10px}
button{background:#ffd23f;color:#0e1a5c;font-weight:700}a{color:#ffd23f}.box{background:#1530b3;padding:14px;border-radius:8px;margin-top:14px}</style></head>
<body><h1>Painel do Stop</h1>
<form action="/conectar" method="get">
<label for="user">@ da conta que vai fazer a live (sem o @)</label>
<input id="user" name="user" value="${escapar(usuarioAtual)}" placeholder="seuusuario" autocapitalize="none" autocomplete="off">
<button type="submit">Conectar</button></form>
<div class="box"><b>Situação:</b><br>${escapar(ultimoStatus)}</div>
<p><a href="/painel">Atualizar situação</a> · <a href="/">Abrir o jogo</a></p>
</body></html>`;
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/" || url.pathname === "/index.html") {
    fs.readFile(path.join(pasta, "index.html"), (err, dados) => {
      if (err) { res.writeHead(500); res.end("index.html não encontrado"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(dados);
    });
    return;
  }

  if (url.pathname === "/eventos") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");
    res.write("data: " + JSON.stringify({ tipo: "status", texto: ultimoStatus }) + "\n\n");
    clientes.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); clientes.delete(res); });
    return;
  }

  if (url.pathname === "/painel") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(paginaPainel());
    return;
  }

  if (url.pathname === "/conectar") {
    usuarioAtual = (url.searchParams.get("user") || "").replace(/^@/, "").trim().slice(0, 40);
    iniciar();
    res.writeHead(302, { Location: "/painel" });
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Não encontrado");
});

servidor.listen(PORTA, "0.0.0.0", () => {
  console.log("Stop ao Vivo rodando na porta " + PORTA);
  if (usuarioAtual) iniciar();
});
