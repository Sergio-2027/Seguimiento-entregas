import { useEffect, useState, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import DeckGL from '@deck.gl/react'
import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers'

const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY)
const COLOR = { 'Pendiente': [150,150,150], 'En camino': [255,140,0], 'Entregado': [30,160,70] }

function useEntregas() {
  const [rows, setRows] = useState([])
  useEffect(() => {
    const cargar = async () => {
      const { data, error } = await supabase.from('entregas').select('*').order('id')
      if (error) console.error(error)
      console.log('entregas', data)
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

/* ---------------- TABLERO (seguimiento) ---------------- */
function Tablero() {
  const rows = useEntregas()
  const enCamino = rows.filter(r => r.estado === 'En camino')
  const kpis = [
    ['Pedidos', rows.length],
    ['En camino', enCamino.length],
    ['Entregados', rows.filter(r => r.estado === 'Entregado').length],
  ]
  const layers = [
    new TileLayer({
      data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', minZoom: 0, maxZoom: 19, tileSize: 256,
      renderSubLayers: p => {
        const { west, south, east, north } = p.tile.bbox
        return new BitmapLayer(p, { data: null, image: p.data, bounds: [west, south, east, north] })
      }
    }),
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
