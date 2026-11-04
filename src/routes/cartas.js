'use strict';
const express = require('express');
const letters = require('../nuevavida/letters');

/**
 * Las cartas de bienvenida se leen sin iniciar sesión: el enlace se manda por WhatsApp a quien recién recibió a Cristo.
 * Solo se sirven los archivos de la lista (letters.LETTERS); la carta es del templo, no contiene datos de nadie.
 */
function cartasRouter() {
  const r = express.Router();
  r.get('/cartas/:file', (req, res) => {
    const letter = letters.letterByFile(req.params.file);
    if (!letter) return res.status(404).type('text').send('No encontrada');
    res.sendFile(letters.letterPath(letter), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${letter.file}"`, 'Cache-Control': 'public, max-age=3600' },
    });
  });
  return r;
}

module.exports = { cartasRouter };
