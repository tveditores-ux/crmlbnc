'use strict';
const express = require('express');
const { layout } = require('../views/layout');
const views = require('../views/calendar');
const cal = require('../calendar');

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Calendario general (solo lectura): se arma con eventos, fechas de nacimiento y líderes. */
function calendarRouter(ctx) {
  const { db, config } = ctx;
  const r = express.Router();
  r.get(
    '/calendario',
    ah(async (req, res) => {
      const today = cal.today(config.timezone);
      const month = cal.validMonth(req.query.mes) ? req.query.mes : today.slice(0, 7);
      const filter = Object.hasOwn(cal.FILTERS, req.query.ver) ? req.query.ver : 'todo';
      const { from, to } = cal.monthRange(month);
      const items = (await cal.collect(db, config.timezone, from, to)).filter((i) => cal.FILTERS[filter].includes(i.kind));
      res.setHeader('Cache-Control', 'no-store'); // fechas de nacimiento
      res.send(layout({ title: 'Calendario', active: '/calendario', body: views.monthView({ month, items, today, filter }), config, query: req.query }));
    })
  );
  return r;
}

module.exports = { calendarRouter };
