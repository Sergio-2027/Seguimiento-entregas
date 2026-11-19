import { useEffect, useState, useRef, useMemo } from 'react'
import { createClient } from '@supabase/supabase-js'
import DeckGL from '@deck.gl/react'
import { TileLayer, TripsLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, ScatterplotLayer, LineLayer, TextLayer } from '@deck.gl/layers'
import { HeatmapLayer } from '@deck.gl/aggregation-layers'

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY)

const MAPA_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'  // mapa base de OpenStreetMap (se oscurece con tintColor)
const ATRIB = { position: 'absolute', zIndex: 1, right: 6, bottom: 4, fontSize: 11, color: '#cbd5e1', background: '#0f172acc', padding: '1px 6px', borderRadius: 4 }
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
      data: MAPA_URL, minZoom: 0, maxZoom: 19, tileSize: 256,
      renderSubLayers: p => {
        const { west, south, east, north } = p.tile.bbox
        return new BitmapLayer(p, { data: null, image: p.data, bounds: [west, south, east, north], tintColor: [80, 95, 125], desaturate: 0.4 })
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
      <div style={{ position: 'absolute', zIndex: 2, top: 0, left: 0, right: 0, background: '#0f172a', color: '#e2e8f0', padding: '10px 14px', boxShadow: '0 2px 10px #0008' }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Seguimiento de Entregas en Vivo <span style={{ color: '#4ade80', fontSize: 12, marginLeft: 8 }}>● EN VIVO</span></h2>
        <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          {kpis.map(([l, v]) => <div key={l} style={{ background: '#1e293b', borderRadius: 10, padding: '8px 14px', minWidth: 90 }}><b style={{ fontSize: 24 }}>{v}</b><div style={{ fontSize: 11, color: '#94a3b8' }}>{l}</div></div>)}
          <span style={{ marginLeft: 'auto', alignSelf: 'center', display: 'flex', gap: 16 }}><a href="#/flota" style={{ color: '#38bdf8' }}>Flota y optimización →</a><a href="#/chofer" style={{ color: '#38bdf8' }}>App chofer →</a></span>
        </div>
      </div>

      <DeckGL initialViewState={{ longitude: -58.43, latitude: -34.60, zoom: 11.5 }} controller layers={layers}
        getTooltip={({ object: o }) => o && `Pedido: ${o.pedido}\nCliente: ${o.cliente}\nEstado: ${o.estado}\nChofer: ${o.chofer || '-'}\nKm recorridos: ${(o.km_recorridos || 0).toFixed(1)}`} />

      <div style={ATRIB}>© OpenStreetMap contributors</div>
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
const Dato = ({ l, v }) => (
  <div style={{ background: '#0f172a', borderRadius: 10, padding: '8px 10px' }}>
    <div style={{ color: '#94a3b8', fontSize: 11 }}>{l}</div><div style={{ fontSize: 18, fontWeight: 700 }}>{v}</div>
  </div>
)
const GPS_ESTADOS = { apagado: ['GPS apagado', '#64748b'], buscando: ['Buscando señal…', '#facc15'], ok: ['GPS activo', '#4ade80'],
  debil: ['Señal débil', '#fb923c'], error: ['Sin permiso de GPS', '#f87171'] }

function Chofer() {
  const rows = useEntregas()
  const [nombre, setNombre] = useState(localStorage.getItem('chofer') || '')
  const [activo, setActivo] = useState(null)
  const [km, setKm] = useState(0)
  const [pos, setPos] = useState(null)
  const [gps, setGps] = useState('apagado')
  const watch = useRef(null), ultimo = useRef(0), kmRef = useRef(0), previo = useRef(null), lock = useRef(null)
  const yo = nombre.trim()

  const actualizar = (id, campos) =>
    supabase.from('entregas').update({ ...campos, actualizado: new Date().toISOString() }).eq('id', id)

  // Mantiene la pantalla encendida mientras se sigue el viaje (el GPS necesita el navegador abierto)
  const pantalla = async () => { try { if (navigator.wakeLock) lock.current = await navigator.wakeLock.request('screen') } catch {} }
  const soltar = () => { try { lock.current?.release() } catch {} lock.current = null }
  useEffect(() => {
    const f = () => { if (document.visibilityState === 'visible' && watch.current != null) pantalla() }
    document.addEventListener('visibilitychange', f)
    return () => { document.removeEventListener('visibilitychange', f); if (watch.current != null) navigator.geolocation.clearWatch(watch.current); soltar() }
  }, [])

  const seguir = (r) => {
    setActivo(r.id); kmRef.current = r.km_recorridos || 0; previo.current = null; setKm(kmRef.current)
    setGps('buscando'); pantalla()
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current)
    watch.current = navigator.geolocation.watchPosition(p => {
      const { latitude: la, longitude: lo, accuracy } = p.coords
      setPos({ lat: la, lng: lo }); setGps(accuracy <= 50 ? 'ok' : 'debil')
      if (Date.now() - ultimo.current < 3000) return
      ultimo.current = Date.now()
      if (accuracy <= 50) {            // odómetro: ignora señal mala, ruido y saltos
        if (!previo.current) previo.current = [la, lo]
        else {
          const d = distKm(previo.current[0], previo.current[1], la, lo)
          if (d >= 0.01) { if (d < 1) kmRef.current += d; previo.current = [la, lo] }
        }
        setKm(kmRef.current)
      }
      actualizar(r.id, { lat: la, lng: lo, km_recorridos: kmRef.current })
    }, () => setGps('error'), { enableHighAccuracy: true })
  }

  const iniciar = async (r) => {
    if (!yo) return alert('Escribí tu nombre primero')
    localStorage.setItem('chofer', yo)
    const { data } = await supabase.from('entregas')   // solo lo toma si sigue Pendiente
      .update({ estado: 'En camino', chofer: yo, actualizado: new Date().toISOString() })
      .eq('id', r.id).eq('estado', 'Pendiente').select()
    if (!data || !data.length) return alert('Otro chofer ya tomó este pedido')
    seguir(r)
  }
  const entregar = async (r) => {
    if (!confirm(`¿Confirmás la entrega de ${r.pedido} a ${r.cliente}?`)) return
    if (watch.current != null) navigator.geolocation.clearWatch(watch.current)
    watch.current = null; soltar()
    await actualizar(r.id, { estado: 'Entregado', km_recorridos: kmRef.current })
    setActivo(null); setGps('apagado'); setPos(null)
  }

  const enCurso = yo ? rows.find(r => r.estado === 'En camino' && r.chofer === yo) : null
  const pendientes = rows.filter(r => r.estado === 'Pendiente')
  const hechos = yo ? rows.filter(r => r.estado === 'Entregado' && r.chofer === yo) : []
  const kmDia = hechos.reduce((s, r) => s + (r.km_recorridos || 0), 0) + (enCurso ? (activo === enCurso.id ? km : enCurso.km_recorridos || 0) : 0)
  const [gTxt, gCol] = GPS_ESTADOS[gps]
  const tarjeta = { background: C.tarjeta, borderRadius: 14, padding: 14, marginTop: 12 }
  const grande = (bg, col = '#0f172a') => ({ display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'center', padding: 14, fontSize: 16,
    fontWeight: 700, borderRadius: 10, border: 0, background: bg, color: col, marginTop: 10, textDecoration: 'none' })

  return (
    <div style={{ minHeight: '100vh', background: C.fondo, color: C.texto, padding: 16, boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>App Chofer</div>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: gCol, border: '1px solid ' + gCol, borderRadius: 20, padding: '3px 10px' }}>● {gTxt}</span>
        </div>
        <input placeholder="Tu nombre" value={nombre} onChange={e => setNombre(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: 12, fontSize: 16, marginTop: 12, borderRadius: 10, border: '1px solid #334155', background: C.tarjeta, color: C.texto }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12 }}>
          <Dato l="Entregas hechas" v={hechos.length} />
          <Dato l="Km del día" v={kmDia.toFixed(1)} />
          <Dato l="Combustible (L)" v={(kmDia * L100_BASE / 100).toFixed(1)} />
        </div>

        {enCurso && (() => {
          const escucha = activo === enCurso.id
          const dist = pos ? distKm(pos.lat, pos.lng, enCurso.destino_lat, enCurso.destino_lng) : null
          return (
            <div style={{ ...tarjeta, border: '1px solid ' + C.azul }}>
              <div style={{ color: C.azul, fontSize: 12, fontWeight: 700 }}>VIAJE EN CURSO</div>
              <div style={{ fontSize: 20, fontWeight: 700, margin: '4px 0 10px' }}>{enCurso.pedido} · {enCurso.cliente}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Dato l="Odómetro del viaje" v={(escucha ? km : enCurso.km_recorridos || 0).toFixed(2) + ' km'} />
                <Dato l="Combustible usado" v={((escucha ? km : enCurso.km_recorridos || 0) * L100_BASE / 100).toFixed(2) + ' L'} />
                <Dato l="Distancia al destino" v={dist !== null ? dist.toFixed(1) + ' km' : '—'} />
                <Dato l="Llegada estimada" v={dist !== null ? minutos(dist, VEL_BASE) + ' min' : '—'} />
              </div>
              {dist !== null && dist < 0.15 && <p style={{ color: C.verde, marginBottom: 0 }}>Estás llegando al destino.</p>}
              {escucha ? (
                <>
                  <a href={`https://www.google.com/maps/dir/?api=1&destination=${enCurso.destino_lat},${enCurso.destino_lng}&travelmode=driving`}
                    target="_blank" rel="noreferrer" style={grande(C.azul)}>Navegar al destino</a>
                  <button onClick={() => entregar(enCurso)} style={grande('#16a34a', '#fff')}>Marcar entregado</button>
                </>
              ) : <button onClick={() => seguir(enCurso)} style={grande('#f59e0b')}>Reanudar seguimiento</button>}
            </div>
          )
        })()}

        {!enCurso && (
          <>
            <div style={{ marginTop: 16, fontWeight: 700 }}>Pedidos disponibles ({pendientes.length})</div>
            {pendientes.length === 0 && <p style={{ color: C.suave }}>No quedan pedidos pendientes. ¡Buen trabajo!</p>}
            {pendientes.map(r => (
              <div key={r.id} style={tarjeta}>
                <div style={{ fontWeight: 700 }}>{r.pedido}</div>
                <div style={{ color: C.suave, fontSize: 14 }}>{r.cliente}</div>
                <button onClick={() => iniciar(r)} style={grande(C.azul)}>Iniciar viaje</button>
              </div>
            ))}
          </>
        )}
        {enCurso && <p style={{ color: C.suave, fontSize: 13 }}>Terminá el viaje en curso para tomar otro pedido.</p>}

        {hechos.length > 0 && (
          <div style={tarjeta}>
            <b>Entregados hoy ({hechos.length})</b>
            {hechos.map(r => <div key={r.id} style={{ color: C.suave, fontSize: 13, marginTop: 4 }}>✓ {r.pedido} · {r.cliente} · {(r.km_recorridos || 0).toFixed(1)} km</div>)}
          </div>
        )}
        <p style={{ textAlign: 'center', marginTop: 16 }}><a href="#/" style={{ color: C.azul }}>Ver tablero</a></p>
      </div>
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

/* ---------------- FLOTA: centro de control con mapa de calor y estelas ---------------- */
const hh = h => { const m = Math.round(h * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }
const T0 = 5.8
const PALETA = [[56,189,248],[167,139,250],[244,114,182],[251,146,60],[250,204,21],[74,222,128],[45,212,191],[248,113,113]]
const C = { fondo: '#0f172a', tarjeta: '#1e293b', texto: '#e2e8f0', suave: '#94a3b8', azul: '#38bdf8', verde: '#4ade80', rojo: '#f87171' }
const KPI = [['Unidades', 'unidades', 0, ''], ['Viajes', 'viajes', 0, ''], ['Recorrido', 'km', 0, ' km'], ['Combustible', 'litros', 0, ' L']]
const BARRAS = [['Kilómetros', 'km', ' km'], ['Combustible', 'litros', ' L'], ['CO₂ emitido', 'co2', ' kg']]
const boton = (act, ext = {}) => ({ padding: '9px 12px', borderRadius: 8, border: '1px solid #334155', cursor: 'pointer', fontWeight: 600,
  background: act ? C.azul : C.tarjeta, color: act ? '#0f172a' : C.texto, ...ext })
const barra = { borderRadius: 4, padding: '2px 8px', fontSize: 12, marginTop: 3, whiteSpace: 'nowrap', minWidth: 110 }

function Flota() {
  const [filas, setFilas] = useState([])
  const [msg, setMsg] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [plan, setPlan] = useState('actual')
  const [t, setT] = useState(T0)
  const [play, setPlay] = useState(true)
  const [acum, setAcum] = useState(false)
  const movil = window.innerWidth < 700

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
  const A = stats.actual, B = stats.optimizado, cur = stats[plan], vs = plan === 'optimizado' ? A : null

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
  const viajes = useMemo(() => grupos.map(a => ({ unidad: a[0].unidad, path: a.map(f => [f.lng, f.lat]), ts: a.map(f => f.hora) })), [grupos])
  const camiones = grupos.map(a => { let p = null; for (const f of a) { if (f.hora <= t) p = f; else break } return p && t - p.hora < 0.3 ? p : null }).filter(Boolean)
  const calor = activos.filter(f => f.hora <= t && f.hora > t - (acum ? 99 : 0.75))
  const color = d => PALETA[(d.unidad - 1) % 8]

  const layers = [
    new TileLayer({
      data: MAPA_URL, minZoom: 0, maxZoom: 19, tileSize: 256,
      renderSubLayers: p => {
        const { west, south, east, north } = p.tile.bbox
        return new BitmapLayer(p, { data: null, image: p.data, bounds: [west, south, east, north], tintColor: [80, 95, 125], desaturate: 0.4 })
      }
    }),
    ...(calor.length ? [new HeatmapLayer({ id: 'calor', data: calor, getPosition: d => [d.lng, d.lat], getWeight: 1,
      radiusPixels: 34, intensity: 2, threshold: 0.04 })] : []),
    new TripsLayer({ id: 'estelas', data: viajes, getPath: d => d.path, getTimestamps: d => d.ts, getColor: color,
      currentTime: t, trailLength: 0.6, fadeTrail: true, widthMinPixels: 4, capRounded: true, jointRounded: true }),
    new ScatterplotLayer({ id: 'deposito', data: [DEPOSITO], getPosition: d => [d.lng, d.lat], getFillColor: [56, 189, 248],
      getLineColor: [255, 255, 255], stroked: true, lineWidthMinPixels: 3, getRadius: 13, radiusUnits: 'pixels' }),
    new ScatterplotLayer({ id: 'camiones', data: camiones, getPosition: d => [d.lng, d.lat], getFillColor: color,
      getLineColor: [255, 255, 255], stroked: true, lineWidthMinPixels: 2, getRadius: 11, radiusUnits: 'pixels' }),
    new TextLayer({ id: 'unidades', data: camiones, getPosition: d => [d.lng, d.lat], getText: d => String(d.unidad),
      getSize: 12, getColor: [15, 23, 42] }),
  ]

  const panel = movil ? { left: 0, right: 0, bottom: 0, maxHeight: '60%' } : { top: 0, bottom: 0, left: 0, width: 400 }
  const lk = { color: C.azul }
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <DeckGL initialViewState={movil ? { longitude: -58.65, latitude: -34.62, zoom: 8.8 } : { longitude: -58.83, latitude: -34.48, zoom: 9.6 }}
        controller layers={layers} />
      <div style={ATRIB}>© OpenStreetMap contributors</div>
      <div style={{ position: 'absolute', zIndex: 2, ...panel, background: C.fondo, color: C.texto, padding: 16, overflowY: 'auto', fontSize: 14, boxShadow: '0 0 18px #0008' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div><div style={{ fontSize: 18, fontWeight: 700 }}>Flota y optimización</div>
            <div style={{ color: C.suave, fontSize: 12 }}>Gemelo digital · Depósito General Pacheco</div></div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 13 }}><a href="#/" style={lk}>Tablero</a><a href="#/chofer" style={lk}>Chofer</a></span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button disabled={ocupado} onClick={generar} style={boton(false)}>Generar recorridos (8 unidades)</button>
          <button disabled={ocupado || !A} onClick={optimizar} style={boton(true)}>Optimizar rutas (6 camiones)</button>
        </div>
        {msg && <p style={{ color: C.suave }}>{msg}</p>}
        {!A && !ocupado && !msg && <p style={{ color: C.suave }}>Todavía no hay recorridos en la base. Tocá "Generar recorridos".</p>}

        {A && (
          <>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button onClick={() => { setPlan('actual'); setT(T0) }} style={boton(plan === 'actual', { flex: 1 })}>Plan actual</button>
              <button disabled={!B} onClick={() => { setPlan('optimizado'); setT(T0) }} style={boton(plan === 'optimizado', { flex: 1 })}>Plan optimizado</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              {KPI.map(([l, k, d, u]) => {
                const dp = vs ? (cur[k] - vs[k]) / vs[k] * 100 : null
                return (
                  <div key={k} style={{ background: C.tarjeta, borderRadius: 12, padding: '10px 12px' }}>
                    <div style={{ color: C.suave, fontSize: 12 }}>{l}</div>
                    <div style={{ fontSize: 24, fontWeight: 700 }}>{cur[k].toFixed(d)}<span style={{ fontSize: 13, color: C.suave }}>{u}</span></div>
                    {dp !== null && <div style={{ fontSize: 12, color: dp < 0 ? C.verde : C.rojo }}>{dp < 0 ? '▼' : '▲'} {Math.abs(dp).toFixed(0)} % vs plan actual</div>}
                  </div>
                )
              })}
            </div>

            <div style={{ background: C.tarjeta, borderRadius: 12, padding: 12, marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button onClick={() => setPlay(!play)} style={boton(false)}>{play ? '❚❚ Pausa' : '▶ Reproducir'}</button>
                <b style={{ fontSize: 22 }}>{hh(t)}</b>
                <label style={{ marginLeft: 'auto', fontSize: 13 }}><input type="checkbox" checked={acum} onChange={e => setAcum(e.target.checked)} /> Acumulado</label>
              </div>
              <input type="range" min={T0} max={tFin} step="0.01" value={t} onChange={e => setT(+e.target.value)} style={{ width: '100%', marginTop: 8 }} />
              <div style={{ color: C.suave, fontSize: 12 }}>Estelas de colores: un color por camión. Calor: dónde se concentró el paso en los últimos 45 minutos. Punto celeste: depósito.</div>
            </div>
          </>
        )}

        {A && B && (
          <div style={{ background: C.tarjeta, borderRadius: 12, padding: 12, marginTop: 12 }}>
            <b>Comparación de planes</b>
            {BARRAS.map(([l, k, u]) => (
              <div key={k} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: C.suave }}>{l}</div>
                <div style={{ ...barra, background: '#7f1d1d', width: '100%' }}>Actual {A[k].toFixed(0)}{u}</div>
                <div style={{ ...barra, background: '#166534', width: (B[k] / A[k] * 100) + '%' }}>Optimizado {B[k].toFixed(0)}{u}</div>
              </div>
            ))}
            <div style={{ marginTop: 10, fontSize: 13 }}>Fin de la jornada: {hh(A.fin)} → <b style={{ color: C.verde }}>{hh(B.fin)}</b></div>
            <p style={{ color: C.suave, fontSize: 12, marginBottom: 0 }}>
              Misma demanda de {N_PARADAS} paradas. Se agrupan por zona, se consolidan viajes de 4 paradas (antes 3) y cada recorrido se ordena por vecino más cercano.
              Datos simulados, distancias en línea recta, consumo supuesto de {L100_FLOTA} L/100 km.
            </p>
          </div>
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
