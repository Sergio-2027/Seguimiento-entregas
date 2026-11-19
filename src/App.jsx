import { ScatterplotLayer, PathLayer } from '@deck.gl/layers'

// ---- Supuestos editables ----
export const DEPOSITO = { pedido: 'Depósito', lat: -34.6345, lng: -58.4000 } // cambiá por tu depósito real
const FACTOR_CALLE = 1.3 // la distancia por calle es ~30% mayor que la línea recta
const DIAS = 30          // días del histórico ficticio
const CELDA = 0.004      // tamaño de la grilla del mapa de calor (~400 m)

const dKm = (a, b) => {
  const t = x => x * Math.PI / 180
  const h = Math.sin(t(b.lat - a.lat) / 2) ** 2 +
    Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lng - a.lng) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

// Aleatorio con semilla: el histórico es ficticio pero siempre da lo mismo
const rng = seed => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }

const mezclar = (arr, r) => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Largo de la ruta: depósito -> paradas -> depósito
const largoKm = ruta => {
  let t = 0, prev = DEPOSITO
  for (const p of ruta) { t += dKm(prev, p); prev = p }
  return (t + dKm(prev, DEPOSITO)) * FACTOR_CALLE
}

// Optimización: vecino más cercano + mejora 2-opt
function optimizar(paradas) {
  let resto = [...paradas], ruta = [], actual = DEPOSITO
  while (resto.length) {
    let i = 0
    resto.forEach((p, j) => { if (dKm(actual, p) < dKm(actual, resto[i])) i = j })
    actual = resto.splice(i, 1)[0]
    ruta.push(actual)
  }
  let mejora = true
  while (mejora) {
    mejora = false
    for (let i = 0; i < ruta.length - 1; i++) {
      for (let j = i + 1; j < ruta.length; j++) {
        const nuevo = [...ruta.slice(0, i), ...ruta.slice(i, j + 1).reverse(), ...ruta.slice(j + 1)]
        if (largoKm(nuevo) < largoKm(ruta) - 1e-9) { ruta = nuevo; mejora = true }
      }
    }
  }
  return ruta
}

export function calcularAnalisis(rows, vel, l100) {
  const paradas = rows.filter(r => r.destino_lat && r.destino_lng)
    .map(r => ({ id: r.id, pedido: r.pedido, cliente: r.cliente, lat: r.destino_lat, lng: r.destino_lng }))
  if (paradas.length < 3) return null
  const r = rng(12345)

  // Histórico ficticio: cada día se visitan los mismos clientes en un orden sin criterio
  const dias = Array.from({ length: DIAS }, () => {
    const orden = mezclar(paradas, r)
    return { orden, km: largoKm(orden) }
  })
  const kmProm = dias.reduce((s, d) => s + d.km, 0) / DIAS
  const tipico = dias.reduce((m, d) => Math.abs(d.km - kmProm) < Math.abs(m.km - kmProm) ? d : m)

  const despues = optimizar(paradas)
  const m = km => ({ km, min: km / vel * 60, litros: km * l100 / 100 })

  // Mapa de calor: entregas históricas (con dispersión) agrupadas en una grilla
  const mapa = new Map()
  let total = 0
  for (let d = 0; d < DIAS; d++) for (const p of paradas) {
    const n = 1 + Math.floor(r() * 3)
    for (let k = 0; k < n; k++) {
      const la = Math.round((p.lat + (r() - 0.5) * 0.008) / CELDA)
      const lo = Math.round((p.lng + (r() - 0.5) * 0.008) / CELDA)
      const key = la + '_' + lo
      const c = mapa.get(key) || { pos: [lo * CELDA, la * CELDA], n: 0 }
      c.n++; total++; mapa.set(key, c)
    }
  }
  const lista = [...mapa.values()]
  const max = Math.max(...lista.map(c => c.n))
  const celdas = lista.map(c => {
    const t = c.n / max
    return { ...c, color: [255, Math.round(230 * (1 - t)), 0, Math.round(70 + 150 * t)] }
  })

  return { antes: tipico.orden, despues, mAntes: m(kmProm), mDespues: m(largoKm(despues)), celdas, total }
}

export function capasAnalisis(modo, vista, A) {
  if (!A || modo === 'normal') return []
  if (modo === 'calor') {
    return [new ScatterplotLayer({ id: 'calor', data: A.celdas, getPosition: d => d.pos,
      getFillColor: d => d.color, getRadius: 260, radiusUnits: 'meters' })]
  }
  const ruta = vista === 'antes' ? A.antes : A.despues
  const color = vista === 'antes' ? [200, 40, 40] : [30, 160, 70]
  const camino = [[DEPOSITO.lng, DEPOSITO.lat], ...ruta.map(p => [p.lng, p.lat]), [DEPOSITO.lng, DEPOSITO.lat]]
  return [
    new PathLayer({ id: 'ruta', data: [{ camino }], getPath: d => d.camino,
      getColor: color, getWidth: 5, widthUnits: 'pixels' }),
    new ScatterplotLayer({ id: 'ruta-paradas', data: ruta, getPosition: d => [d.lng, d.lat],
      getFillColor: color, getLineColor: [255, 255, 255], stroked: true, lineWidthMinPixels: 2,
      getRadius: 11, radiusUnits: 'pixels' }),
    new ScatterplotLayer({ id: 'deposito', data: [DEPOSITO], getPosition: d => [d.lng, d.lat],
      getFillColor: [20, 20, 20], getLineColor: [255, 255, 255], stroked: true, lineWidthMinPixels: 3,
      getRadius: 15, radiusUnits: 'pixels' }),
  ]
}

const boton = on => ({ padding: '6px 10px', borderRadius: 6, border: '1px solid #0a6cff',
  background: on ? '#0a6cff' : '#fff', color: on ? '#fff' : '#0a6cff', fontSize: 14 })

export function PanelAnalisis({ modo, setModo, vista, setVista, A }) {
  const caja = { borderTop: '1px solid #ddd', marginTop: 10, paddingTop: 8, fontSize: 14 }
  const a = A?.mAntes, d = A?.mDespues
  const fila = (nombre, x, y, dec, unidad) => (
    <tr key={nombre}>
      <td>{nombre}</td>
      <td style={{ textAlign: 'right' }}>{x.toFixed(dec)}</td>
      <td style={{ textAlign: 'right' }}>{y.toFixed(dec)}</td>
      <td style={{ textAlign: 'right', color: '#1ea046' }}>-{(x - y).toFixed(dec)} {unidad}</td>
    </tr>
  )
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={boton(modo === 'calor')} onClick={() => setModo(modo === 'calor' ? 'normal' : 'calor')}>
          Mapa de calor
        </button>
        <button style={boton(modo === 'ruta')} onClick={() => { setModo(modo === 'ruta' ? 'normal' : 'ruta'); setVista('despues') }}>
          Optimizar rutas
        </button>
        {modo === 'ruta' && (
          <button style={boton(true)} onClick={() => setVista(vista === 'antes' ? 'despues' : 'antes')}>
            Antes / Después
          </button>
        )}
      </div>

      {modo !== 'normal' && !A && (
        <div style={caja}>Faltan al menos 3 pedidos con destino_lat y destino_lng para calcular.</div>
      )}

      {modo === 'calor' && A && (
        <div style={caja}>
          <b>Mapa de calor</b>: {A.total} entregas de los últimos {DIAS} días (histórico ficticio).
          Rojo intenso = zonas con más entregas; amarillo = menos.
        </div>
      )}

      {modo === 'ruta' && A && (
        <div style={caja}>
          <b style={{ color: vista === 'antes' ? '#c33' : '#1ea046' }}>
            {vista === 'antes' ? 'ANTES: ruta del histórico (rojo)' : 'DESPUÉS: ruta optimizada (verde)'}
          </b>
          <table style={{ width: '100%', marginTop: 6, fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'right', color: '#666' }}>
                <th style={{ textAlign: 'left' }}>Por día</th><th>Antes</th><th>Después</th><th>Ahorro</th>
              </tr>
            </thead>
            <tbody>
              {fila('Distancia', a.km, d.km, 1, 'km')}
              {fila('Tiempo', a.min, d.min, 0, 'min')}
              {fila('Combustible', a.litros, d.litros, 1, 'L')}
            </tbody>
          </table>
          <div style={{ marginTop: 6 }}>
            Mejora: <b>{((a.km - d.km) / a.km * 100).toFixed(0)}%</b> menos recorrido ·
            en {DIAS} días: <b>{((a.km - d.km) * DIAS).toFixed(0)} km</b> y <b>{((a.litros - d.litros) * DIAS).toFixed(0)} L</b> menos.
          </div>
          <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
            Histórico ficticio: mismos clientes en orden sin criterio. Optimización: vecino más cercano + 2-opt.
            Distancia por calle estimada como línea recta x {FACTOR_CALLE}.
          </div>
        </div>
      )}
    </div>
  )
}
