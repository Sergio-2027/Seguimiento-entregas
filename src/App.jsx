

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import DeckGL from '@deck.gl/react'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, ScatterplotLayer, LineLayer } from '@deck.gl/layers'

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY)

const COLOR = { 'Pendiente': [150,150,150], 'En camino': [255,140,0], 'Entregado': [30,160,70] }

// ---- Gemelo digital: parámetros y cálculos ----
const VEL_BASE = 25 // km/h supuesta en ciudad (velocidad planificada)

const distKm = (lat1, lng1, lat2, lng2) => {
  const t = x => x * Math.PI / 180
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 +
    Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lng2 - lng1) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}
const minutos = (km, vel) => Math.round(km / vel * 60)

// Réplica virtual de cada viaje: toma datos reales y calcula ETA planificada y simulada
function gemelo(rows, vel) {
  return rows.map(r => {
    if (r.estado !== 'En camino' || !r.lat) return { ...r, dist: null }
    const dist = distKm(r.lat, r.lng, r.destino_lat, r.destino_lng)
    const plan = minutos(dist, VEL_BASE)
    const sim = minutos(dist, vel)
    return { ...r, dist, plan, sim, demora: sim - plan }
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

  const kpis = [
    ['Pedidos', rows.length],
    ['En camino', enCamino.length],
    ['Entregados', rows.filter(r => r.estado === 'Entregado').length],
  ]

  const reiniciar = async () => {
    if (!confirm('¿Reiniciar todos los viajes a "Pendiente"?')) return
    const { error } = await supabase.from('entregas')
      .update({ estado: 'Pendiente', chofer: null, lat: null, lng: null, actualizado: new Date().toISOString() })
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
        <div style={{ display: 'flex', gap: 24, marginTop: 8 }}>
          {kpis.map(([l, v]) => <div key={l}><b style={{ fontSize: 28 }}>{v}</b><div style={{ fontSize: 12 }}>{l}</div></div>)}
          <a href="#/chofer" style={{ marginLeft: 'auto', alignSelf: 'center' }}>Ir a app chofer →</a>
        </div>
      </div>

      <DeckGL initialViewState={{ longitude: -58.43, latitude: -34.60, zoom: 11.5 }} controller layers={layers}
        getTooltip={({ object: o }) => o && `Pedido: ${o.pedido}\nCliente: ${o.cliente}\nEstado: ${o.estado}\nChofer: ${o.chofer || '-'}`} />

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
            </div>

            {enCamino.length === 0 && <p style={{ fontSize: 14, color: '#666' }}>No hay viajes en camino. Iniciá uno desde la app chofer.</p>}

            {enCamino.map(r => (
              <div key={r.id} style={{ borderTop: '1px solid #ddd', marginTop: 10, paddingTop: 8, fontSize: 14 }}>
                <b>{r.pedido}</b> – {r.cliente} <small>({r.chofer || 'sin chofer'})</small><br />
                {r.dist === null
                  ? <span style={{ color: '#666' }}>Esperando señal GPS del chofer…</span>
                  : <>
                      Distancia al destino: {r.dist.toFixed(1)} km<br />
                      ETA planificada: {r.plan} min · ETA simulada: <b>{r.sim} min</b>{' '}
                      <span style={{ color: r.demora > 0 ? '#c33' : r.demora < 0 ? '#1ea046' : '#666' }}>
                        ({r.demora > 0 ? '+' : ''}{r.demora} min)
                      </span>
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
  const watch = useRef(null)
  const ultimo = useRef(0)

  const actualizar = (id, campos) =>
    supabase.from('entregas').update({ ...campos, actualizado: new Date().toISOString() }).eq('id', id)

  const iniciar = async (r) => {
    if (!nombre) return alert('Escribí tu nombre')
    localStorage.setItem('chofer', nombre)
    setActivo(r.id)
    await actualizar(r.id, { estado: 'En camino', chofer: nombre })
    watch.current = navigator.geolocation.watchPosition(
      pos => {
        if (Date.now() - ultimo.current < 3000) return
        ultimo.current = Date.now()
        actualizar(r.id, { lat: pos.coords.latitude, lng: pos.coords.longitude })
      },
      err => alert('GPS: ' + err.message), { enableHighAccuracy: true })
  }

  const entregar = async (r) => {
    navigator.geolocation.clearWatch(watch.current)
    await actualizar(r.id, { estado: 'Entregado' })
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
          <small>Estado: {r.estado} {r.chofer && `(${r.chofer})`}</small><br /><br />
          {activo === r.id
            ? <button style={{ ...btn, background: '#1ea046' }} onClick={() => entregar(r)}>Marcar entregado</button>
            : r.estado === 'Pendiente' && <button style={btn} onClick={() => iniciar(r)}>Iniciar viaje</button>}
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
