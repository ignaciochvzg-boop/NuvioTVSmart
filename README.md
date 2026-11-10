# NuvioTV Smart — soporte Tizen 3.0 (TVs Samsung 2017)

Fork de [NuvioMedia/NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart) que añade soporte real para **Tizen 3.0 / Chromium 47**: el sistema de las TVs Samsung de 2017, que la versión oficial **no soporta** (su política de compatibilidad exige Tizen 4.0+ / Chromium 56+, es decir, TV 2018 en adelante).

**Dispositivo de pruebas:** Samsung **UN58MU6120F** (2017, Tizen 3.0, Chromium 47, SoC de un solo núcleo).

**Versión base:** 1.3.7 del proyecto original. El upstream ya publicó la 1.3.11 (con mejoras propias para TV); este fork aún no la integra — hacerlo exige re-verificar todo en el equipo antes de publicarlo.

## Estado: qué funciona y qué no

### Funciona (verificado en el TV) ✅

- **Addons HTML** (streams HTTP directos): sincronización, listado y reproducción. **Testeado con addons HTML** — 9 addons instalados, entre ellos catálogo Nuvio, OpenSubtitles v3 y addons de streaming tipo hdhub / webstreamrmbg.
- **Subtítulos funcionando**: OpenSubtitles v3 y subtítulos embebidos en la reproducción.
- **Login por QR** con tu cuenta Nuvio; la sesión persiste entre reinicios.
- **Reproducción 1080p** por MSE, en tiempo real, sin errores de consola.
- **Velocidad de carga**: arranque rápido, movimiento de D-pad suave y respuesta inmediata (cifras abajo).
- Ajustes, biblioteca, búsqueda y navegación general.

### No probado ⚠️

- **Debrid y servicios similares** (Real-Debrid, AllDebrid, etc.): **no se ha probado** en este equipo. No se puede afirmar que funcione ni que falle.

### No funciona ❌

- **Torrents / streams P2P**: **no funcionan en Tizen**. No es una omisión de este port: la propia aplicación lo indica en pantalla (*«Torrent/P2P streaming is not supported on this TV»*) y su código desactiva el motor P2P en Tizen. Útil solo con addons HTML.

## Rendimiento medido (UN58MU6120F)

| Métrica | Resultado |
|---|---|
| Procesado de variables CSS (antes, cuello de botella) | 57,6 s → **9,5 s**, y sin bloquear la interfaz |
| Contenido visible tras arrancar | 76–92 s → **~14,5 s** |
| Movimiento D-pad | 25–111 ms por pulsación (media 52 ms) |
| Tarjeta de stream → pantalla de reproductor | **1,4 s** |
| Reproducción | 1080p en tiempo real, 35 min de buffer, 0 errores |
| Pósters / tarjetas del inicio | 204×314 / 212×322 (idéntico al original) |
| Almacenamiento | 159 KB en localStorage, 61 MB de heap, sin escrituras a disco |

## Instalación

En la TV se instala en modo desarrollador, firmado con tu propio certificado (mismo proceso que cualquier app WGT de Tizen).

### Requisitos

- PC con **Tizen Studio** (incluye las herramientas `tizen` y `sdb`) — descarga desde `developer.tizen.org`.
- TV en la misma red local que el PC.
- Node.js (para compilar desde el código).

### Pasos

1. **TV — Developer Mode**: instala la app **«Developer Mode»** desde la tienda de la TV, introduce la IP de tu PC, actívalo y **reinicia la TV**.
2. **Conectar**: `sdb connect <IP-DE-LA-TV>`.
3. **Certificado**: en Tizen Studio abre *Certificate Manager* → *+* → **Author** (alias y contraseña; anótalos). Es el que permite instalar en modo desarrollador.
4. **Compilar**: en este repositorio:

   ```bash
   npm install
   npm run package:tizen
   ```

   genera el paquete `NuvioTV001_1.3.7.wgt`.
5. **Firmar** (reemplaza `<alias>` por el de tu certificado):

   ```bash
   tizen package -t wgt -s <alias> -o salida -- NuvioTV001_1.3.7.wgt
   ```
6. **Instalar** en la TV:

   ```bash
   python scripts/sdb_install.py <IP-DE-LA-TV>
   ```

   (o `sdb install salida/NuvioTV001_1.3.7.wgt`).

7. Abre la app en la TV y **inicia sesión escaneando el QR** con tu teléfono (con sesión en Nuvio).

## Cambios respecto al proyecto original

- Compilación a dos etapas (esbuild + Babel) con verificador de sintaxis para Chromium 47.
- Bundle dividido en scripts ordenados (Chromium 47 no compila un bundle de 4 MB de una pasada en estos SoC).
- Polyfills para Chromium 47: AbortController, URLSearchParams, IntersectionObserver, ResizeObserver, css-vars-ponyfill.
- Procesado de variables CSS acelerado de 58 s a ~9 s, sin bloquear el hilo principal.
- `Node.isConnected` polyfill (posters del inicio).
- `startFragPrefetch` activado (primer fragmento de vídeo antes).
- Política de compatibilidad: Tizen 2017 / 3.0 / Chromium 47.

## Licencia y atribución

- **GPL-3.0** (ver [LICENSE](LICENSE)) — igual que el proyecto original.
- Fork no oficial de [NuvioMedia/NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart); el crédito es suyo. Sin relación con NuvioMedia ni con Samsung.
- El README original del upstream está en el [repositorio oficial](https://github.com/NuvioMedia/NuvioTVSmart#readme).
