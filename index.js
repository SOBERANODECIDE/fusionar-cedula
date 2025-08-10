// bump deploy to force reinstall

const express = require("express");
const fetch = require("node-fetch");
const sharp = require("sharp");
const { google } = require("googleapis"); // Google Sheets

const app = express();

/* ============================
   CORS
============================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ============================
   JSON grande (Base64)
============================ */
app.use(express.json({ limit: "20mb" }));

/* ============================
   Util: tornar branco quase puro transparente
============================ */
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

/* ============================
   Fusão de PNG (retorna PNG)
   body: { base64Overlay, urlBaseImage }
============================ */
app.post("/fusionar-cedula", async (req, res) => {
  try {
    const { base64Overlay, urlBaseImage } = req.body;
    if (!base64Overlay || !urlBaseImage) {
      return res.status(400).send("Faltan datos: base64Overlay y urlBaseImage.");
    }

    // Base oficial (Supabase)
    const baseResp = await fetch(urlBaseImage);
    if (!baseResp.ok) throw new Error("No se pudo descargar la imagen base.");
    const baseBuf = await baseResp.buffer();

    const baseSharp = sharp(baseBuf);
    const meta = await baseSharp.metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) throw new Error("No se pudo leer dimensiones de la imagen base.");

    // Overlay (capa do usuário)
    const overlayRaw = Buffer.from(
      String(base64Overlay).replace(/^data:image\/\w+;base64,/, ""),
      "base64"
    );

    const overlaySized = await sharp(overlayRaw)
      .resize({ width: W, height: H, fit: "cover" })
      .png()
      .toBuffer();

    const overlayNoWhite = await whiteToTransparent(overlaySized, 250);

    // Funde
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

/* ============================
   PDF A4 (86×120 mm) via PDFKit (híbrido)
   body aceita:
   - { fusedBase64 }   ou  { fusedUrl }
   - { base64Overlay, urlBaseImage }  (fallback: funde no servidor)
============================ */
app.post("/png-to-a4-pdf", async (req, res) => {
  try {
    const { fusedBase64, fusedUrl, base64Overlay, urlBaseImage } = req.body;
    let pngBuffer;

    if (fusedBase64 || fusedUrl) {
      // Caso 1: PNG final já fundida
      if (fusedBase64) {
        const b64 = String(fusedBase64).replace(/^data:image\/\w+;base64,/, "");
        pngBuffer = Buffer.from(b64, "base64");
      } else {
        const r = await fetch(fusedUrl);
        if (!r.ok) throw new Error("No se pudo descargar la imagen final.");
        pngBuffer = await r.buffer();
      }
    } else if (base64Overlay && urlBaseImage) {
      // Caso 2: CAPA + URL da base → funde no servidor
      const baseResp = await fetch(urlBaseImage);
      if (!baseResp.ok) throw new Error("No se pudo descargar la imagen base.");
      const baseBuf = await baseResp.buffer();

      const baseSharp = sharp(baseBuf);
      const { width: W, height: H } = await baseSharp.metadata();
      if (!W || !H) throw new Error("Dimensiones inválidas de la imagen base.");

      const overlayRaw = Buffer.from(
        String(base64Overlay).replace(/^data:image\/\w+;base64,/, ""),
        "base64"
      );

      const overlaySized = await sharp(overlayRaw)
        .resize({ width: W, height: H, fit: "cover" })
        .png()
        .toBuffer();

      // tornar branco transparente (opcional)
      const { data, info } = await sharp(overlaySized).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        if (r >= 250 && g >= 250 && b >= 250) data[i+3] = 0;
      }
      const overlayNoWhite = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 }
      }).png().toBuffer();

      pngBuffer = await baseSharp
        .resize({ width: W, height: H })
        .composite([{ input: overlayNoWhite, blend: "over" }])
        .png()
        .toBuffer();
    } else {
      return res.status(400).send("Faltan datos: fusedBase64/fusedUrl o base64Overlay+urlBaseImage.");
    }

    // PDF A4 com 86×120 mm centralizado
    const mmToPt = mm => Math.round((mm / 25.4) * 72);
    const A4_W = mmToPt(210), A4_H = mmToPt(297);
    const CED_W = mmToPt(86),  CED_H = mmToPt(120);
    const left = Math.round((A4_W - CED_W) / 2);
    const top  = Math.round((A4_H - CED_H) / 2);

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

    doc.rect(0, 0, A4_W, A4_H).fill("#FFFFFF");
    doc.image(pngBuffer, left, top, { width: CED_W, height: CED_H });
    doc.end();

  } catch (err) {
    res.status(500).send("Error al generar PDF A4: " + err.message);
  }
});

/* ============================
   DEBUG: ver variáveis de ambiente (sem expor valores)
============================ */
app.get("/debug-env", (req, res) => {
  res.json({
    hasEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    hasKey: !!process.env.GOOGLE_PRIVATE_KEY,
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID || null,
    tabName_env: process.env.SHEETS_TAB_NAME || null
  });
});

/* ============================
   DEBUG: listar as abas da planilha
============================ */
app.get("/list-sheets", async (req, res) => {
  try {
    let privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const titles = (meta.data.sheets || []).map(s => s.properties.title);
    res.json({ titles });
  } catch (e) {
    res.status(500).send("Erro ao listar abas: " + e.message);
  }
});

/* ============================
   Teste de escrita no Google Sheets (TEMPORÁRIO)
   Requer variáveis de ambiente:
   - GOOGLE_SERVICE_ACCOUNT_EMAIL
   - GOOGLE_PRIVATE_KEY  (com \n; o código converte)
   - SHEETS_SPREADSHEET_ID
   - (opcional) SHEETS_TAB_NAME (default "Registros")
============================ */
app.post("/test-sheets", async (req, res) => {
  try {
    const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_PRIVATE_KEY || "";
    privateKey = privateKey.replace(/\\n/g, "\n"); // corrige \n literais

    if (!clientEmail || !privateKey) {
      return res.status(500).send("Faltam GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY");
    }

    const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID;
    let tabName = process.env.SHEETS_TAB_NAME || "Registros";
    if (!spreadsheetId) {
      return res.status(500).send("Falta SHEETS_SPREADSHEET_ID");
    }

    // força aspas simples no nome da aba (seguro para espaço/acentos/hífens/aspas)
    const safeTab = `'${String(tabName).trim().replace(/'/g, "''")}'`;

    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // 🔽 Dados de teste — ajuste se quiser
    const row = [
      "Teste Integración",
      "Caracas",
      "01/01/2000",
      "+58",
      "4140000000",
      "teste@example.com",
      "00000099",
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${safeTab}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });

    res.json({ ok: true, appended: row, range: `${safeTab}!A:G`, tabName });
  } catch (e) {
    res.status(500).send("Erro ao escrever no Sheets: " + e.message);
  }
});

/* ============================
   Health
============================ */
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));
app.get("/", (req, res) => res.send("API de fusão de cédulas ativa."));

/* ============================
   Start server
============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));








