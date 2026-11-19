import { useEffect, useState, useRef, useMemo } from 'react'
import { createClient } from '@supabase/supabase-js'
import DeckGL from '@deck.gl/react'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, ScatterplotLayer, LineLayer, TextLayer } from '@deck.gl/layers'
import { HeatmapLayer } from '@deck.gl/aggregation-layers'

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY)

const COLOR = { 'Pendiente': [150,150,150], 'En camino': [255,140,0], 'Entregado': [30,160,70] }

// ---- Gemelo digital: parámetros y cálculos ----
const VEL_BASE = 25      // km/h supuesta en ciudad (velocidad planificada)
const L100_BASE = 20     // litros cada 100 km (camión liviano de reparto, supuesto)
const RALENTI_LH = 1.5   // litros por hora con el camión detenido o en demora (supuesto)

const distKm = (lat1, lng1, lat2, lng2) => {
  const t = x => x * Math.PI / 180
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 +
    Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lng2 - lng1) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}
const minutos = (km, vel) => Math.round(km / vel * 60)

// Réplica virtual de cada viaje: toma datos reales y calcula ETA, odómetro y combustible
function gemelo(rows, vel) {
  return rows.map(r => {
    const l100 = r.consumo_l100 || L100_BASE
    const km = r.km_recorridos || 0                 // odómetro (real, medido por GPS)
    const usado = km * l100 / 100                   // combustible ya consumido
    if (r.estado !== 'En camino' || !r.lat) return { ...r, dist: null, km, usado }
    const dist = distKm(r.lat, r.lng, r.destino_lat, r.destino_lng)
    const plan = minutos(dist, VEL_BASE)
    const sim = minutos(dist, vel)
    const demora = sim - plan
    // combustible que falta: distancia restante + ralentí por la demora simulada
    const restante = dist * l100 / 100 + Math.max(0, demora) / 60 * RALENTI_LH
    return { ...r, dist, plan, sim, demora, km, usado, restante, total: usado + restante }
  })
}

function useEntregas() {
  const [rows, setRows] = useState([])
  useEffect(() => {
    const cargar = async () => {
      const { data, error } = await supabase.from('entregas').select('*').order('id')
      if (error) console.error(error)
      setRows(data || [])
    }
    cargar()
    const ch = supabase.channel('entregas-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entregas' }, cargar)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [])
  return rows
}

/* ---------------- TABLERO (seguimiento + gemelo digital) ---------------- */
function Tablero() {
  const rows = useEntregas()
  const [vel, setVel] = useState(VEL_BASE)
  const [abierto, setAbierto] = useState(true)
  const twin = gemelo(rows, vel)
  const enCamino = twin.filter(r => r.estado === 'En camino')
  const kmTotal = twin.reduce((s, r) => s + r.km, 0)
  const litrosTotal = twin.reduce((s, r) => s + r.usado, 0)

  const kpis = [
    ['Pedidos', rows.length],
    ['En camino', enCamino.length],
    ['Entregados', rows.filter(r => r.estado === 'Entregado').length],
    ['Km recorridos', kmTotal.toFixed(1)],
    ['Combustible usado (L)', litrosTotal.toFixed(1)],
  ]

  const reiniciar = async () => {
    if (!confirm('¿Reiniciar todos los viajes a "Pendiente"?')) return
    const { error } = await supabase.from('entregas')
      .update({ estado: 'Pendiente', chofer: null, lat: null, lng: null, km_recorridos: 0, actualizado: new Date().toISOString() })
      .neq('estado', 'Pendiente')
    if (error) alert('No se pudo reiniciar: ' + error.message)
  }

  const layers = [
    new TileLayer({
      data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', minZoom: 0, maxZoom: 19, tileSize: 256,
      renderSubLayers: p => {
        const { west, south, east, north } = p.tile.bbox
        return new BitmapLayer(p, { data: null, image: p.data, bounds: [west, south, east, north] })
      }
    }),
    // Gemelo: línea entre la posición real del camión y su destino
    new LineLayer({ id: 'trayecto', data: enCamino.filter(r => r.dist !== null),
      getSourcePosition: d => [d.lng, d.lat], getTargetPosition: d => [d.destino_lng, d.destino_lat],
      getColor: [255, 140, 0], getWidth: 3, widthUnits: 'pixels' }),
    new ScatterplotLayer({ id: 'destinos', data: rows, pickable: true,
      getPosition: d => [d.destino_lng, d.destino_lat], getFillColor: d => COLOR[d.estado],
      getRadius: 10, radiusUnits: 'pixels' }),
    new ScatterplotLayer({ id: 'choferes', data: rows.filter(r => r.lat && r.estado === 'En camino'), pickable: true,
      getPosition: d => [d.lng, d.lat], getFillColor: [220,30,30], getLineColor: [255,255,255],
      stroked: true, lineWidthMinPixels: 3, getRadius: 14, radiusUnits: 'pixels' }),
  ]

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div style={{ position: 'absolute', zIndex: 2, top: 0, left: 0, right: 0, background: '#fff', padding: 12, boxShadow: '0 2px 6px #0003' }}>
        <h2 style={{ margin: 0 }}>Seguimiento de Entregas en Vivo</h2>
        <div style={{ display: 'flex', gap: 24, marginTop: 8, flexWrap: 'wrap' }}>
          {kpis.map(([l, v]) => <div key={l}><b style={{ fontSize: 28 }}>{v}</b><div style={{ fontSize: 12 }}>{l}</div></div>)}
          <span style={{ marginLeft: 'auto', alignSelf: 'center', display: 'flex', gap: 16 }}><a href="#/flota">Flota y optimización →</a><a href="#/chofer">App chofer →</a></span>
        </div>
      </div>

      <DeckGL initialViewState={{ longitude: -58.43, latitude: -34.60, zoom: 11.5 }} controller layers={layers}
        getTooltip={({ object: o }) => o && `Pedido: ${o.pedido}\nCliente: ${o.cliente}\nEstado: ${o.estado}\nChofer: ${o.chofer || '-'}\nKm recorridos: ${(o.km_recorridos || 0).toFixed(1)}`} />

      {/* Panel del gemelo digital */}
      <div style={{ position: 'absolute', zIndex: 2, left: 0, right: 0, bottom: 0, background: '#fff',
        boxShadow: '0 -2px 6px #0003', padding: 12, maxHeight: abierto ? '42%' : 'auto', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 16 }}>Gemelo digital</b>
          <button onClick={reiniciar} style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 6, border: '1px solid #c33', background: '#fff', color: '#c33' }}>
            Reiniciar viajes
          </button>
          <button onClick={() => setAbierto(!abierto)} style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #999', background: '#fff' }}>
            {abierto ? 'Ocultar' : 'Mostrar'}
          </button>
        </div>

        {abierto && (
          <>
            <div style={{ marginTop: 10, fontSize: 14 }}>
              Simulación de tráfico: velocidad promedio <b>{vel} km/h</b>
              {vel < VEL_BASE ? ' (con demora)' : vel > VEL_BASE ? ' (tránsito fluido)' : ' (planificada)'}
              <input type="range" min="8" max="45" value={vel} onChange={e => setVel(+e.target.value)}
                style={{ width: '100%', display: 'block', marginTop: 4 }} />
              <button onClick={() => setVel(VEL_BASE)} style={{ fontSize: 12, padding: '2px 8px' }}>Volver a lo planificado</button>
              <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                Supuestos: consumo {L100_BASE} L/100 km · ralentí {RALENTI_LH} L/h en demora
              </div>
            </div>

            {enCamino.length === 0 && <p style={{ fontSize: 14, color: '#666' }}>No hay viajes en camino. Iniciá uno desde la app chofer.</p>}

            {enCamino.map(r => (
              <div key={r.id} style={{ borderTop: '1px solid #ddd', marginTop: 10, paddingTop: 8, fontSize: 14 }}>
                <b>{r.pedido}</b> – {r.cliente} <small>({r.chofer || 'sin chofer'})</small><br />
                Odómetro del viaje: <b>{r.km.toFixed(1)} km</b> · Combustible usado: <b>{r.usado.toFixed(1)} L</b><br />
                {r.dist === null
                  ? <span style={{ color: '#666' }}>Esperando señal GPS del chofer…</span>
                  : <>
                      Distancia al destino: {r.dist.toFixed(1)} km<br />
                      ETA planificada: {r.plan} min · ETA simulada: <b>{r.sim} min</b>{' '}
                      <span style={{ color: r.demora > 0 ? '#c33' : r.demora < 0 ? '#1ea046' : '#666' }}>
                        ({r.demora > 0 ? '+' : ''}{r.demora} min)
                      </span><br />
                      Combustible que falta: <b>{r.restante.toFixed(1)} L</b> · Total estimado del viaje: <b>{r.total.toFixed(1)} L</b>
                    </>}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/* ---------------- APP CHOFER ---------------- */
function Chofer() {
  const rows = useEntregas()
  const [nombre, setNombre] = useState(localStorage.getItem('chofer') || '')
  const [activo, setActivo] = useState(null)
  const [km, setKm] = useState(0)
  const watch = useRef(null)
  const ultimo = useRef(0)
  const kmRef = useRef(0)     // odómetro acumulado del viaje
  const previo = useRef(null) // último punto GPS contado

  const actualizar = (id, campos) =>
    supabase.from('entregas').update({ ...campos, actualizado: new Date().toISOString() }).eq('id', id)

  const iniciar = async (r) => {
    if (!nombre) return alert('Escribí tu nombre')
    localStorage.setItem('chofer', nombre)
    setActivo(r.id)
    kmRef.current = r.km_recorridos || 0
    previo.current = null
    setKm(kmRef.current)
    await actualizar(r.id, { estado: 'En camino', chofer: nombre })
    watch.current = navigator.geolocation.watchPosition(
      pos => {
        if (Date.now() - ultimo.current < 3000) return
        ultimo.current = Date.now()
        const { latitude: la, longitude: lo, accuracy } = pos.coords
        // Odómetro: suma la distancia entre puntos GPS (ignora señal mala, ruido y saltos)
        if (accuracy <= 50) {
          if (!previo.current) previo.current = [la, lo]
          else {
            const d = distKm(previo.current[0], previo.current[1], la, lo)
            if (d >= 0.01) {            // se movió al menos 10 m
              if (d < 1) kmRef.current += d
              previo.current = [la, lo]
            }
          }
          setKm(kmRef.current)
        }
        actualizar(r.id, { lat: la, lng: lo, km_recorridos: kmRef.current })
      },
      err => alert('GPS: ' + err.message), { enableHighAccuracy: true })
  }

  const entregar = async (r) => {
    navigator.geolocation.clearWatch(watch.current)
    await actualizar(r.id, { estado: 'Entregado', km_recorridos: kmRef.current })
    setActivo(null)
  }

  const btn = { padding: '10px 14px', fontSize: 16, borderRadius: 8, border: 0, background: '#0a6cff', color: '#fff' }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 16 }}>
      <h2>App Chofer</h2>
      <input placeholder="Tu nombre" value={nombre} onChange={e => setNombre(e.target.value)}
        style={{ width: '100%', padding: 10, fontSize: 16, boxSizing: 'border-box' }} />
      <p><a href="#/">← Ver tablero</a></p>
      {rows.filter(r => r.estado !== 'Entregado').map(r => (
        <div key={r.id} style={{ border: '1px solid #ccc', borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <b>{r.pedido}</b> – {r.cliente}<br />
          <small>Estado: {r.estado} {r.chofer && `(${r.chofer})`}</small><br />
          {activo === r.id && <small>Odómetro del viaje: <b>{km.toFixed(2)} km</b></small>}<br />
          {activo === r.id
            ? <button style={{ ...btn, background: '#1ea046' }} onClick={() => entregar(r)}>Marcar entregado</button>
            : r.estado === 'Pendiente' && <button style={btn} onClick={() => iniciar(r)}>Iniciar viaje</button>}
        </div>
      ))}
    </div>
  )
}

// ---- Flota: demanda simulada, plan actual y plan optimizado ----
const DEPOSITO = { lat: -34.4600, lng: -58.6350 }   // Depósito en General Pacheco
const ZONAS = [[-34.4260,-58.5797],[-34.4710,-58.5280],[-34.5260,-58.4740],[-34.5470,-58.5530],[-34.5780,-58.5370],
  [-34.4950,-58.6170],[-34.4228,-58.7458],[-34.3480,-58.7940],[-34.4587,-58.9140],[-34.5020,-58.6990],
  [-34.5120,-58.7690],[-34.5430,-58.7120],[-34.5630,-58.4560],[-34.5880,-58.4200],[-34.6037,-58.3816]]
const N_PARADAS = 48, PASO_KM = 0.6, VEL_FLOTA = 25, PARADA_H = 0.25, CARGA_H = 0.5, L100_FLOTA = 20, CO2_L = 2.68

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

// Misma demanda para los dos planes (semilla fija)
function generarParadas() {
  const r = mulberry32(2026)
  return Array.from({ length: N_PARADAS }, (_, i) => {
    const z = ZONAS[Math.floor(r() * ZONAS.length)]
    return { id: i + 1, lat: z[0] + (r() - .5) * .03, lng: z[1] + (r() - .5) * .03 }
  })
}
const d2 = (a, b) => distKm(a.lat, a.lng, b.lat, b.lng)

// Plan actual: 8 unidades, pedidos repartidos por orden de llegada, 3 paradas por viaje
function planActual(paradas) {
  const viajes = []
  for (let u = 0; u < 8; u++) {
    const mias = paradas.filter((_, i) => i % 8 === u)
    for (let k = 0; k < mias.length; k += 3) viajes.push({ unidad: u, paradas: mias.slice(k, k + 3) })
  }
  return viajes
}

// Plan optimizado: 6 unidades. Zonas por barrido angular, 4 paradas por viaje, orden por vecino más cercano
function planOptimizado(paradas) {
  const ang = p => Math.atan2(p.lat - DEPOSITO.lat, p.lng - DEPOSITO.lng)
  const orden = [...paradas].sort((a, b) => ang(a) - ang(b))
  const viajes = []
  for (let k = 0, v = 0; k < orden.length; k += 4, v++) {
    const rest = orden.slice(k, k + 4), ruta = []
    let pos = DEPOSITO
    while (rest.length) {
      rest.sort((a, b) => d2(pos, a) - d2(pos, b))
      pos = rest.shift(); ruta.push(pos)
    }
    viajes.push({ unidad: v % 6, paradas: ruta })
  }
  return viajes
}

// Convierte los viajes en puntos GPS simulados (uno cada ~600 m) con su hora del día
function construirFilas(viajes, escenario) {
  const libre = {}, nviaje = {}, filas = []
  viajes.forEach(v => {
    const u = v.unidad
    let hora = libre[u] ?? 6 + u * 0.2
    const n = nviaje[u] = (nviaje[u] || 0) + 1
    let orden = 0
    const ruta = [DEPOSITO, ...v.paradas, DEPOSITO]
    const push = (lat, lng) => filas.push({ escenario, unidad: u + 1, viaje: n, orden: orden++, lat: +lat.toFixed(5), lng: +lng.toFixed(5), hora: +hora.toFixed(3) })
    for (let i = 0; i < ruta.length - 1; i++) {
      const a = ruta[i], b = ruta[i + 1], d = d2(a, b), pasos = Math.max(1, Math.ceil(d / PASO_KM))
      for (let s = 0; s < pasos; s++) {
        push(a.lat + (b.lat - a.lat) * s / pasos, a.lng + (b.lng - a.lng) * s / pasos)
        hora += d / pasos / VEL_FLOTA
      }
      if (i < ruta.length - 2) hora += PARADA_H   // tiempo de descarga en la parada
    }
    push(DEPOSITO.lat, DEPOSITO.lng)
    libre[u] = hora + CARGA_H                       // carga en depósito antes del próximo viaje
  })
  return filas
}

// Estadísticas calculadas a partir de los puntos guardados en la base
function estadisticas(filas) {
  const g = {}
  filas.forEach(f => { (g[f.unidad + '-' + f.viaje] ||= []).push(f) })
  let km = 0
  Object.values(g).forEach(a => {
    a.sort((x, y) => x.orden - y.orden)
    for (let i = 1; i < a.length; i++) km += distKm(a[i - 1].lat, a[i - 1].lng, a[i].lat, a[i].lng)
  })
  const litros = km * L100_FLOTA / 100
  return { unidades: new Set(filas.map(f => f.unidad)).size, viajes: Object.keys(g).length,
    km, horas: km / VEL_FLOTA, litros, co2: litros * CO2_L, fin: Math.max(...filas.map(f => f.hora)) }
}

/* ---------------- FLOTA: mapa de calor animado + optimización ---------------- */
const hh = h => { const m = Math.round(h * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }
const TABLA = [['Unidades en ruta', 'unidades', 0], ['Viajes realizados', 'viajes', 0], ['Km recorridos', 'km', 0],
  ['Horas de conducción', 'horas', 1], ['Combustible (L)', 'litros', 0], ['CO₂ emitido (kg)', 'co2', 0]]
const T0 = 5.8

function Flota() {
  const [filas, setFilas] = useState([])
  const [msg, setMsg] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [plan, setPlan] = useState('actual')
  const [t, setT] = useState(T0)
  const [play, setPlay] = useState(true)
  const [acum, setAcum] = useState(false)

  const cargar = async () => {
    let out = [], desde = 0
    while (true) {
      const { data, error } = await supabase.from('recorridos').select('*').order('id').range(desde, desde + 999)
      if (error) { setMsg('Error: ' + error.message + ' (¿ejecutaste el SQL de actualización en Supabase?)'); break }
      out = out.concat(data)
      if (data.length < 1000) break
      desde += 1000
    }
    setFilas(out)
  }
  useEffect(() => { cargar() }, [])

  const guardar = async (escenario, nuevas) => {
    await supabase.from('recorridos').delete().eq('escenario', escenario)
    for (let i = 0; i < nuevas.length; i += 500) {
      const { error } = await supabase.from('recorridos').insert(nuevas.slice(i, i + 500))
      if (error) throw error
    }
  }
  const correr = async (texto, tarea, planNuevo) => {
    setOcupado(true); setMsg(texto)
    try { await tarea(); await cargar(); setPlan(planNuevo); setT(T0); setMsg('') }
    catch (e) { setMsg('Error: ' + e.message) }
    setOcupado(false)
  }
  const generar = () => correr('Generando los recorridos de las 8 unidades…', async () => {
    await guardar('optimizado', [])
    await guardar('actual', construirFilas(planActual(generarParadas()), 'actual'))
  }, 'actual')
  const optimizar = () => correr('Optimizando rutas con 6 camiones…', () =>
    guardar('optimizado', construirFilas(planOptimizado(generarParadas()), 'optimizado')), 'optimizado')

  const { porPlan, stats, tFin } = useMemo(() => {
    const p = { actual: filas.filter(f => f.escenario === 'actual'), optimizado: filas.filter(f => f.escenario === 'optimizado') }
    return { porPlan: p, tFin: filas.length ? Math.max(...filas.map(f => f.hora)) + 0.3 : 18,
      stats: { actual: p.actual.length ? estadisticas(p.actual) : null, optimizado: p.optimizado.length ? estadisticas(p.optimizado) : null } }
  }, [filas])
  const activos = porPlan[plan]
  const A = stats.actual, B = stats.optimizado

  useEffect(() => {
    if (!play) return
    const id = setInterval(() => setT(x => x >= tFin ? T0 : x + 0.04), 100)
    return () => clearInterval(id)
  }, [play, tFin])

  const grupos = useMemo(() => {
    const g = {}
    activos.forEach(f => { (g[f.unidad + '-' + f.viaje] ||= []).push(f) })
    return Object.values(g).map(a => a.sort((x, y) => x.orden - y.orden))
  }, [activos])
  const camiones = grupos.map(a => { let p = null; for (const f of a) { if (f.hora <= t) p = f; else break } return p && t - p.hora < 0.3 ? p : null }).filter(Boolean)
  const calor = activos.filter(f => f.hora <= t && f.hora > t - (acum ? 99 : 0.75))

  const layers = [
    new TileLayer({
      data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', minZoom: 0, maxZoom: 19, tileSize: 256,
      renderSubLayers: p => {
        const { west, south, east, north } = p.tile.bbox
        return new BitmapLayer(p, { data: null, image: p.data, bounds: [west, south, east, north] })
      }
    }),
    ...(calor.length ? [new HeatmapLayer({ id: 'calor', data: calor, getPosition: d => [d.lng, d.lat], getWeight: 1,
      radiusPixels: 32, intensity: 2, threshold: 0.04 })] : []),
    new ScatterplotLayer({ id: 'deposito', data: [DEPOSITO], getPosition: d => [d.lng, d.lat], getFillColor: [10, 108, 255],
      getLineColor: [255, 255, 255], stroked: true, lineWidthMinPixels: 3, getRadius: 12, radiusUnits: 'pixels' }),
    new ScatterplotLayer({ id: 'camiones', data: camiones, getPosition: d => [d.lng, d.lat], getFillColor: [30, 30, 30],
      getLineColor: [255, 255, 255], stroked: true, lineWidthMinPixels: 2, getRadius: 10, radiusUnits: 'pixels' }),
    new TextLayer({ id: 'unidades', data: camiones, getPosition: d => [d.lng, d.lat], getText: d => String(d.unidad),
      getSize: 12, getColor: [255, 255, 255] }),
  ]

  const bt = (extra = {}) => ({ padding: '8px 12px', borderRadius: 6, border: '1px solid #999', background: '#fff', cursor: 'pointer', ...extra })
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <DeckGL initialViewState={{ longitude: -58.65, latitude: -34.48, zoom: 9.6 }} controller layers={layers} />
      <div style={{ position: 'absolute', zIndex: 2, left: 0, right: 0, bottom: 0, background: '#fff',
        boxShadow: '0 -2px 6px #0003', padding: 12, maxHeight: '58%', overflowY: 'auto', fontSize: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 16 }}>Flota y optimización de rutas</b>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}><a href="#/">Tablero</a><a href="#/chofer">App chofer</a></span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button disabled={ocupado} onClick={generar} style={bt()}>Generar recorridos (8 unidades)</button>
          <button disabled={ocupado || !A} onClick={optimizar} style={bt({ background: '#0a6cff', color: '#fff', border: 0 })}>Optimizar rutas (6 camiones)</button>
        </div>
        {msg && <p style={{ color: '#555' }}>{msg}</p>}
        {!A && !ocupado && !msg && <p style={{ color: '#666' }}>Todavía no hay recorridos en la base. Tocá "Generar recorridos".</p>}

        {A && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => setPlay(!play)} style={bt()}>{play ? 'Pausa' : 'Reproducir'}</button>
              <b>{hh(t)}</b>
              <label><input type="checkbox" checked={acum} onChange={e => setAcum(e.target.checked)} /> Acumulado</label>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => { setPlan('actual'); setT(T0) }} style={bt(plan === 'actual' ? { background: '#222', color: '#fff' } : {})}>Plan actual</button>
                <button disabled={!B} onClick={() => { setPlan('optimizado'); setT(T0) }} style={bt(plan === 'optimizado' ? { background: '#222', color: '#fff' } : {})}>Plan optimizado</button>
              </span>
            </div>
            <input type="range" min={T0} max={tFin} step="0.01" value={t} onChange={e => setT(+e.target.value)} style={{ width: '100%', marginTop: 6 }} />
            <small style={{ color: '#666' }}>El mapa de calor muestra por dónde pasaron los camiones en los últimos 45 minutos. Los puntos negros son las unidades; el azul es el depósito.</small>
          </div>
        )}

        {A && B && (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
              <thead><tr><th align="left">Indicador</th><th align="right">Plan actual</th><th align="right">Optimizado</th><th align="right">Mejora</th></tr></thead>
              <tbody>{TABLA.map(([l, k, d]) => {
                const a = A[k], b = B[k], p = (a - b) / a * 100
                return <tr key={k} style={{ borderTop: '1px solid #ddd' }}><td>{l}</td><td align="right">{a.toFixed(d)}</td>
                  <td align="right"><b>{b.toFixed(d)}</b></td><td align="right" style={{ color: '#1ea046' }}>{p > 0 ? '−' : '+'}{Math.abs(p).toFixed(0)} %</td></tr>
              })}
                <tr style={{ borderTop: '1px solid #ddd' }}><td>Fin de la jornada</td><td align="right">{hh(A.fin)}</td><td align="right"><b>{hh(B.fin)}</b></td><td /></tr>
              </tbody>
            </table>
            <div style={{ marginTop: 10 }}>
              Combustible
              <div style={{ background: '#c33', color: '#fff', width: '100%', padding: '2px 6px', marginTop: 4 }}>Actual: {A.litros.toFixed(0)} L</div>
              <div style={{ background: '#1ea046', color: '#fff', width: (B.litros / A.litros * 100) + '%', minWidth: 110, padding: '2px 6px', marginTop: 4 }}>Optimizado: {B.litros.toFixed(0)} L</div>
            </div>
            <p style={{ color: '#555', fontSize: 13 }}>
              Cómo se optimizó (misma demanda de {N_PARADAS} paradas): se agrupan los pedidos por zona alrededor del depósito, se arman viajes de 4 paradas en lugar de 3
              (consolidación de carga) y se ordena cada recorrido por vecino más cercano. Resultado: menos viajes, menos camiones y menos kilómetros.
              Datos simulados; distancias en línea recta; consumo supuesto de {L100_FLOTA} L/100 km.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [ruta, setRuta] = useState(location.hash)
  useEffect(() => { const f = () => setRuta(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return ruta === '#/chofer' ? <Chofer /> : ruta === '#/flota' ? <Flota /> : <Tablero />
}
