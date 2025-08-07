
const express = require("express");
const fetch = require("node-fetch");
const sharp = require("sharp");

const app = express();// Habilitar CORS para permitir requisições do navegador
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204); // Resposta para preflight
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

app.post("/fusionar-cedula", async (req, res) => {
  const { base64Overlay, urlBaseImage } = req.body;

  if (!base64Overlay || !urlBaseImage) {
    return res.status(400).json({ error: "Faltan datos de entrada." });
  }

  try {
    const overlayBuffer = Buffer.from(base64Overlay.replace(/^data:image\/\w+;base64,/, ""), "base64");

    const response = await fetch(urlBaseImage);
    const baseImageBuffer = await response.buffer();

    const finalImage = await sharp(baseImageBuffer)
      .composite([{ input: overlayBuffer, blend: "over" }])
      .resize({ width: 1016, height: 1417 }) // Aproximadamente 86mm x 120mm em 300dpi
      .png()
      .toBuffer();

    res.set("Content-Type", "image/png");
    res.send(finalImage);
  } catch (err) {
    res.status(500).send("Erro ao fundir imagens: " + err.message);
  }
});

app.get("/", (req, res) => {
  res.send("API de fusão de cédulas ativa.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
