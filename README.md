# Milov — Komodin Wave Enrichment

Extensión de Chrome (Manifest V3) que enriquece la tabla **Crear Wave**
(`https://milov-wms.komodin.io/wave_new/`) del WMS Komodin con datos de
milov-app y guarda cada wave como una OLA asignada a un camión:

- Columnas: ruta/zona, tipo (**Reparto** o **Retiro en bodega**), fecha de
  entrega, chofer/OLA, cantidad, **peso** (kg y m³) y notas completas.
- Filtros: varias rutas, zona, chofer, tipo, fecha de entrega (botón
  **Mañana**) y búsqueda.
- **Peso por camión**: carga de cada vehículo en la fecha elegida.
- Al crear el wave: fecha de salida, **viaje** (sumarse a uno existente o crear
  uno nuevo), vehículo y chofer, con la ocupación por peso y volumen.

## Cómo funciona

- La tabla del WMS es HTML insertado por jQuery en `#prop` tras "Aplicar
  Filtros" (`POST /wave_new_ajax/`). El content script la detecta por el
  encabezado **Reff** (número de SO), pide el enriquecimiento y agrega las
  columnas. Un `MutationObserver` reprocesa cada re-render.
- El service worker es el único que habla con milov-app con
  `Authorization: Bearer mlv_ext_…`; el content script nunca ve la API key.
  Cache de 2 minutos por SO.
- Al pulsar **Crear Wave** la extensión detiene la acción, guarda la OLA en
  milov-app y después continúa con Komodin. Si Komodin va a rechazar el wave
  (menos de 2 salidas o campos obligatorios vacíos), no se intercepta y se ve
  la alerta de Komodin.

## Peso y volumen

milov-app calcula la carga de cada SO con los datos de **Komodin**:

| Línea de la SO | Peso |
| --- | --- |
| En piezas (PCS, UD) | cantidad × peso de la caja ÷ piezas por caja |
| En cajas (CJ, caja) | cantidad × peso de la caja |
| Por peso (KG, g, lb) | la cantidad ya es el peso |

El peso y las medidas de la ficha de Komodin son de la **caja** (p. ej. Atún
48×140 g = 8.95 kg; medidas en cm) y las piezas por caja salen de sus factores
de UoM (UD 1 · CJ 48). milov-app copia ambos reportes ("Listado de Productos" y
"Factor_UoM_Caja") cada día; en Rutas → Vehículos, **Sincronizar productos de
Komodin** lo hace al momento.

Si a un producto le falta peso, medidas o conversión, el peso se muestra como
mínimo (**≥ 120 kg · Parcial**) y el detalle lista qué falta con enlace a la
ficha del producto en Komodin. Nunca se cuenta como cero.

## Viajes y capacidad

- Un **viaje** es una ruta programada o en curso, o una OLA cuyos paquetes aún
  no llegan. Las rutas finalizadas o canceladas ya no ocupan el vehículo.
- La capacidad es **por viaje**: peso máximo (kg) y volumen útil (m³)
  configurados en milov-app (Rutas → Vehículos). La capacidad en bins y el
  cubicaje del WMS no se usan.
- Al elegir un vehículo que ya tiene un viaje ese día, el diálogo ofrece
  **sumarse** a ese viaje; también se puede crear otro si el camión sale dos
  veces. Al sumarse se conservan el vehículo y el chofer del viaje, y las SO
  que ya estaban en él no se cuentan dos veces.
- Si la carga excede la capacidad hay que marcar **Confirmo que la carga
  excede**. milov-app vuelve a calcular al guardar (otro usuario pudo cargar el
  mismo viaje) y rechaza el exceso no confirmado.
- **Retiro en bodega** (pedido local o campo "Se retira en bodega" de Zoho):
  va en el wave de Komodin pero no ocupa camión, no requiere chofer y su
  paquete no se asigna a ruta al llegar.

## Requisitos en milov-app

1. Migraciones aplicadas, incluidas `20260924120000_vehicle_weight_volume_load.sql`
   y `20260925120000_wms_product_logistics.sql`.
2. Una API key con scopes `wave_enrich` y `wave_plan`:

   ```bash
   node --env-file=.env.local scripts/create-extension-api-key.mjs --label "Bodega Principal"
   ```

   Para revocar: `--revoke <id>`.

3. En **Rutas → Vehículos**: sincronizar vehículos del WMS, configurar el
   **peso máximo** (y opcionalmente el volumen útil) de cada vehículo activo, y
   sincronizar productos de Komodin. La misma página lista los productos más
   vendidos a los que les falta algún dato en Komodin.

## Instalación (modo desarrollador)

1. Chrome → `chrome://extensions` → activar **Modo de desarrollador**.
2. **Cargar descomprimida** → seleccionar esta carpeta.
3. Clic derecho en el ícono de la extensión → **Opciones**: pegar la URL de
   milov-app y la API key → **Guardar** → **Probar conexión**.
4. Abrir `https://milov-wms.komodin.io/wave_new/`, aplicar filtros: las columnas
   Milov aparecen a la derecha de "Status".

## Desarrollo local

En Opciones se puede apuntar la URL a `http://localhost:3000` (ya está en
`host_permissions`). Si se usa otro dominio, agregarlo a `host_permissions` en
`manifest.json` y recargar la extensión.

Pruebas de navegador con una tabla Komodin simulada (sin llamadas a producción):

```bash
npm ci
npm test
```

Requieren Google Chrome instalado. `PLAYWRIGHT_CHANNEL` permite elegir otro
canal instalado compatible con Playwright. Incluyen filtros combinados, cierre
del listado de rutas, notas largas, peso parcial, retiro en bodega, peso por
camión, viaje nuevo con exceso confirmado, sumarse a un viaje existente,
rechazo de capacidad del servidor, validaciones de Komodin y reemplazo de la
tabla.

## Notas / limitaciones

- Filas cuya Reff no es una SO (`ASM-…`, `TO-…`) se muestran sin enriquecer;
  si se seleccionan, el peso del viaje se marca como parcial.
- Si se cancela el `confirm` de Komodin después de guardar, la OLA queda
  guardada; al volver a crear el wave con las mismas SO, fecha, chofer y
  vehículo, milov-app reutiliza esa OLA.
- El badge rojo **Difiere** aparece cuando la SO está en una OLA planificada
  para una fecha distinta a la fecha de entrega pedida.
- Si Komodin cambia el HTML de la tabla (encabezado "Reff"), hay que ajustar
  `content.js`.
- La API key requiere los scopes `wave_enrich` y `wave_plan`. La migración de
  planeación agrega `wave_plan` a las claves activas que ya tengan
  `wave_enrich`.
- El enriquecimiento se consulta por lotes de 300 SO; cada wave admite un
  máximo de 300 SO, conforme a la API de planeación.
- Para subir a chrome store:
  ```bash
  zip milov-komodin-extension.zip manifest.json background.js content.js content.css options.html options.js
  ```

# Milov-WMS-Chrome-Extension
