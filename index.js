
const express = require("express");
const fetch = require("node-fetch");
const sharp = require("sharp");

const app = express();

// CORS (topo)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// JSON grande (base64)
app.use(express.json({ limit: "20mb" }));

// === Util: remover branco quase puro (torna transparente) ===
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

// === Fusão PNG (retorna PNG) ===
app.post("/fusionar-cedula", async (req, res) => {
  try {
    const { base64Overlay, urlBaseImage } = req.body;
    if (!base64Overlay || !urlBaseImage) {
      return res.status(400).send("Faltan datos: base64Overlay y urlBaseImage.");
    }

    // base oficial (Supabase)
    const baseResp = await fetch(urlBaseImage);
    if (!baseResp.ok) throw new Error("No se pudo descargar la imagen base.");
    const baseBuf = await baseResp.buffer();

    const baseSharp = sharp(baseBuf);
    const meta = await baseSharp.metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) throw new Error("No se pudo leer dimensiones de la imagen base.");

    // overlay (capa do usuário)
    const overlayRaw = Buffer.from(
      base64Overlay.replace(/^data:image\/\w+;base64,/, ""),
      "base64"
    );

    const overlaySized = await sharp(overlayRaw)
      .resize({ width: W, height: H, fit: "cover" })
      .png()
      .toBuffer();

    const overlayNoWhite = await whiteToTransparent(overlaySized, 250);

    // funde
    const finalPng = await baseSharp
      .resize({ width: W, height: H })
      .composite([{ input: overlayNoWhite, blend: "over" }])
      .png()
      .toBuffer();

    res.set("Content-Type", "image/png");
    return res.send(finalPng);
  } catch (err) {
    return res.status(500).send("Erro ao fundir imagens: " + err.message);
  }
});

// === Health (uma só vez) ===
app.get("/", (req, res) => res.send("API de fusão de cédulas ativa."));
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

// === PDF A4 (86×120 mm) via PDFKit ===
app.post("/png-to-a4-pdf", async (req, res) => {
  try {
    const { fusedBase64, fusedUrl } = req.body;
    if (!fusedBase64 && !fusedUrl) {
      return res.status(400).send("Faltan datos: fusedBase64 o fusedUrl.");
    }

    // buffer da PNG final
    let pngBuffer;
    if (fusedBase64) {
      const b64 = fusedBase64.replace(/^data:image\/\w+;base64,/, "");
      pngBuffer = Buffer.from(b64, "base64");
    } else {
      const r = await fetch(fusedUrl);
      if (!r.ok) throw new Error("No se pudo descargar la imagen final.");
      pngBuffer = await r.buffer();
    }

    // medidas em pontos
    const mmToPt = mm => Math.round((mm / 25.4) * 72);
    const A4_W = mmToPt(210);
    const A4_H = mmToPt(297);
    const CED_W = mmToPt(86);
    const CED_H = mmToPt(120);
    const left  = Math.round((A4_W - CED_W) / 2);
    const top   = Math.round((A4_H - CED_H) / 2);

    const PDFDocument = require("pdfkit");
    const doc = new PDFDocument({ size: [A4_W, A4_H], margin: 0 });

    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="Cedula_A4.pdf"');
      res.send(pdfBuffer);
    });

    // fundo branco + imagem centralizada
    doc.rect(0, 0, A4_W, A4_H).fill("#FFFFFF");
    doc.image(pngBuffer, left, top, { width: CED_W, height: CED_H });

    doc.end();
  } catch (err) {
    res.status(500).send("Error al generar PDF A4: " + err.message);
  }
});

// === Start server (sempre por último) ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));



