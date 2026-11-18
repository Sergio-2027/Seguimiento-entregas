# Pasos (≈ 30 min)
1. supabase.com > New project. SQL Editor > pegar `setup.sql` > Run.
2. Settings > API: copiar "Project URL" y la clave "anon public".
3. Local: `npm install`, copiar `.env.example` a `.env` y completar, `npm run dev`.
   - Tablero: http://localhost:5173/   Chofer: http://localhost:5173/#/chofer
4. Subir a GitHub > vercel.com > Import project. En "Environment Variables"
   cargar VITE_SUPABASE_URL y VITE_SUPABASE_KEY. Deploy.
5. Probar: abrir el tablero en la compu y /#/chofer en el celular (HTTPS de Vercel,
   necesario para el GPS). Iniciar viaje y caminar: el punto rojo se mueve.
