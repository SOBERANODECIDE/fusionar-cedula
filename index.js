
const express = require("express");
const fetch = require("node-fetch");
const sharp = require("sharp");

const app = express();

// CORS (deixe isto no topo para evitar bloqueios do navegador)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Aumenta o limite do corpo JSON (se o base64 for grande)
app.use(express.json({ limit: "20mb" }));

// Converte “quase branco” em transparente (remove fundo branco da capa)
async function whiteToTransparent(inputBuffer, tolerance = 250) {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r >= tolerance && g >= tolerance && b >= tolerance) data[i + 3] = 0;
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 }
  }).png().toBuffer();
}

app.post("/fusionar-cedula", async (req, res) => {
  try {
    const { base64Overlay, urlBaseImage } = req.body;
    if (!base64Overlay || !urlBaseImage) {
      return res.status(400).send("Faltan datos: base64Overlay y urlBaseImage.");
    }

    // 1) Baixa a imagem base (PNG oficial do Supabase) e lê as dimensões
    const baseResp = await fetch(urlBaseImage);
    if (!baseResp.ok) throw new Error("No se pudo descargar la imagen base.");
    const baseBuf = await baseResp.buffer();

    const baseSharp = sharp(baseBuf);
    const meta = await baseSharp.metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) throw new Error("No se pudo leer dimensiones de la imagen base.");

    // 2) Prepara o overlay: remove prefixo, redimensiona para W×H e remove branco
    const overlayRaw = Buffer.from(
      base64Overlay.replace(/^data:image\/\w+;base64,/, ""),
      "base64"
    );

    const overlaySized = await sharp(overlayRaw)
      .resize({ width: W, height: H, fit: "cover" }) // garante tamanho idêntico
      .png()
      .toBuffer();

    const overlayNoWhite = await whiteToTransparent(overlaySized, 250);

    // 3) Funde (ajuste left/top se precisar micro-alinhar)
    const finalPng = await baseSharp
      .resize({ width: W, height: H })
      .composite([
        { input: overlayNoWhite, blend: "over" }
        // Ex.: { input: overlayNoWhite, left: 2, top: -3, blend: "over" }
      ])
      .png()
      .toBuffer();

    res.set("Content-Type", "image/png");
    return res.send(finalPng);
  } catch (err) {
    return res.status(500).send("Erro ao fundir imagens: " + err.message);
  }
});

app.get("/", (req, res) => res.send("API de fusão de cédulas ativa."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));



