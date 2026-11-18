import { useEffect, useState, useRef, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import DeckGL from '@deck.gl/react'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, ScatterplotLayer, LineLayer } from '@deck.gl/layers'

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY)

const COLOR = { 'Pendiente': [150,150,150], 'En camino': [255,140,0], 'Entregado': [30,160,70] }

// ---- Gemelo digital: parámetros y cálculos ----
const VEL_BASE = 25      // km/h supuesta en ciudad (velocidad planificada)
const L100_BASE = 20     // litros cada 100 km (camión liviano de reparto, supuesto)
const RALENTI_LH = 1.5   // litros por hora con el camión detenido o en demora (supuesto)
const SUBIDA_MS = 5000   // cada cuánto el chofer sube su posición a Supabase

const distKm = (lat1, lng1, lat2, lng2) => {
  const t = x => x * Math.PI / 180
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 +
    Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lng2 - lng1) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}
const minutos = (km, vel) => Math.round(km / vel * 60)

// Supabase puede devolver columnas numeric como string: se convierten a número
const NUM = ['lat', 'lng', 'destino_lat', 'destino_lng', 'km_recorridos', 'consumo_l100']
const norm = r => {
  const o = { ...r }
  for (const k of NUM) if (o[k] !== null && o[k] !== undefined) o[k] = Number(o[k])
  return o
}

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

// Carga inicial + cambios en tiempo real aplicados fila por fila (sin releer toda la tabla)
function useEntregas() {
  const [rows, setRows] = useState([])

  const recargar = useCallback(async () => {
    const { data, error } = await supabase.from('entregas').select('*').order('id')
    if (error) return console.error(error)
    setRows((data || []).map(norm))
  }, [])

  useEffect(() => {
    recargar()
    const ch = supabase.channel('entregas-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'entregas' }, p => {
        setRows(prev => {
          if (p.eventType === 'DELETE') return prev.filter(r => r.id !== p.old.id)
          const nueva = norm(p.new)
          const i = prev.findIndex(r => r.id === nueva.id)
          if (i === -1) return [...prev, nueva].sort((a, b) => a.id - b.id)
          const copia = [...prev]
          copia[i] = nueva
          return copia
        })
      })
      // al (re)conectar se relee todo, por si se perdieron eventos mientras no había conexión
      .subscribe(status => { if (status === 'SUBSCRIBED') recargar() })
    return () => { supabase.removeChannel(ch) }
  }, [recargar])

  return [rows, recargar]
}

/* ---------------- TABLERO (seguimiento + gemelo digital) ---------------- */
function Tablero() {
  const [rows] = useEntregas()
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
      id: 'mapa-base',
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
      getPosition: d => [d.destino_lng, d.destino_lat], getFillColor: d => COLOR[d.estado] || [150,150,150],
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
          <a href="#/chofer" style={{ marginLeft: 'auto', alignSelf: 'center' }}>Ir a app chofer →</a>
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
  const [rows, recargar] = useEntregas()
  const [nombre, setNombre] = useState(localStorage.getItem('chofer') || '')
  const [km, setKm] = useState(0)
  const [aviso, setAviso] = useState('')
  const kmRef = useRef(0)         // odómetro acumulado del viaje
  const previo = useRef(null)     // último punto GPS contado
  const rowsRef = useRef(rows)    // para leer los datos actuales dentro del efecto sin reiniciarlo
  const detenerRef = useRef(null) // corta el GPS (lo usa "Marcar entregado")
  rowsRef.current = rows

  // El viaje activo se deduce de los datos: sobrevive a recargas de la página
  const activo = rows.find(r => r.estado === 'En camino' && r.chofer === nombre.trim())
  const activoId = activo?.id

  const actualizar = (id, campos) =>
    supabase.from('entregas').update({ ...campos, actualizado: new Date().toISOString() }).eq('id', id)

  // GPS + pantalla encendida mientras haya un viaje activo. Se corta solo al salir de la pantalla.
  useEffect(() => {
    if (!activoId) return
    let vivo = true
    let wake = null
    let ultimaSubida = 0

    // retoma el odómetro desde lo guardado en la base
    kmRef.current = rowsRef.current.find(r => r.id === activoId)?.km_recorridos || 0
    previo.current = null
    setKm(kmRef.current)
    setAviso('')

    const pedirWake = async () => {
      try {
        if (!('wakeLock' in navigator)) return
        const lock = await navigator.wakeLock.request('screen')
        if (vivo) wake = lock
        else lock.release().catch(() => {})
      } catch { /* el navegador puede negarlo: no es crítico */ }
    }
    const alVolver = () => { if (vivo && document.visibilityState === 'visible') pedirWake() }
    pedirWake()
    document.addEventListener('visibilitychange', alVolver)

    const watchId = navigator.geolocation.watchPosition(
      pos => {
        if (!vivo) return
        const { latitude: la, longitude: lo, accuracy } = pos.coords
        setAviso('')
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
        // Sube a Supabase como máximo cada SUBIDA_MS
        if (Date.now() - ultimaSubida < SUBIDA_MS) return
        ultimaSubida = Date.now()
        actualizar(activoId, { lat: la, lng: lo, km_recorridos: kmRef.current })
      },
      err => setAviso('GPS: ' + err.message),
      { enableHighAccuracy: true }
    )

    const detener = () => {
      if (!vivo) return
      vivo = false
      navigator.geolocation.clearWatch(watchId)
      document.removeEventListener('visibilitychange', alVolver)
      if (wake) wake.release().catch(() => {})
    }
    detenerRef.current = detener
    return detener
  }, [activoId])

  const iniciar = async (r) => {
    const n = nombre.trim()
    if (!n) return alert('Escribí tu nombre')
    localStorage.setItem('chofer', n)
    // solo toma el pedido si sigue "Pendiente" (evita que dos choferes tomen el mismo)
    const { data, error } = await supabase.from('entregas')
      .update({ estado: 'En camino', chofer: n, actualizado: new Date().toISOString() })
      .eq('id', r.id).eq('estado', 'Pendiente').select()
    if (error) return alert('No se pudo iniciar: ' + error.message)
    if (!data || data.length === 0) alert('Otro chofer ya tomó este pedido')
    recargar()
  }

  const entregar = async (r) => {
    detenerRef.current?.()   // corta el GPS antes, para que no pise el estado con una posición tardía
    const { error } = await actualizar(r.id, { estado: 'Entregado', km_recorridos: kmRef.current })
    if (error) alert('No se pudo marcar como entregado: ' + error.message)
    recargar()
  }

  const btn = { padding: '10px 14px', fontSize: 16, borderRadius: 8, border: 0, background: '#0a6cff', color: '#fff' }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: 16 }}>
      <h2>App Chofer</h2>
      <input placeholder="Tu nombre" value={nombre} onChange={e => setNombre(e.target.value)}
        disabled={!!activo}
        style={{ width: '100%', padding: 10, fontSize: 16, boxSizing: 'border-box' }} />
      <p><a href="#/">← Ver tablero</a></p>
      {aviso && <p style={{ color: '#c33', fontSize: 14 }}>{aviso}</p>}
      {rows.filter(r => r.estado !== 'Entregado').map(r => (
        <div key={r.id} style={{ border: '1px solid #ccc', borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <b>{r.pedido}</b> – {r.cliente}<br />
          <small>Estado: {r.estado} {r.chofer && `(${r.chofer})`}</small><br />
          {activoId === r.id && <small>Odómetro del viaje: <b>{km.toFixed(2)} km</b></small>}<br />
          {activoId === r.id
            ? <button style={{ ...btn, background: '#1ea046' }} onClick={() => entregar(r)}>Marcar entregado</button>
            : r.estado === 'Pendiente' && !activo && <button style={btn} onClick={() => iniciar(r)}>Iniciar viaje</button>}
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [ruta, setRuta] = useState(location.hash)
  useEffect(() => { const f = () => setRuta(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return ruta === '#/chofer' ? <Chofer /> : <Tablero />
}
