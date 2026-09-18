# Milov — Komodin Wave Enrichment

Extensión de Chrome (Manifest V3) que enriquece la tabla **Crear Wave**
(`https://milov-wms.komodin.io/wave_new/`) del WMS Komodin con datos de
milov-app: ruta/zona del cliente, tipo de pedido, fecha de entrega,
chofer planificado, cantidades por temperatura (seco / frío-congelado) y notas.
Agrega además filtros de rutas múltiples, zona, chofer, tipo de pedido, fecha
de entrega (con botón **Mañana**) y búsqueda. Muestra un resumen de cajas y
la ocupación del vehículo elegido. Antes de crear el wave pide
la fecha de salida y el chofer; permite elegir un vehículo y reutilizar una ruta
programada o en curso.

## Cómo funciona

- La tabla del WMS es HTML insertado por jQuery en `#prop` tras "Aplicar
  Filtros" (`POST /wave_new_ajax/`). El content script la detecta por el
  encabezado **Reff** (número de SO), pide el enriquecimiento y agrega las
  columnas. Un `MutationObserver` reprocesa cada re-render.
- El service worker es el único que habla con milov-app:
  `POST /api/sales-order-planning/enrich` con `Authorization: Bearer mlv_ext_…`.
  El content script nunca ve la API key.
- Cache de 2 minutos por SO en el service worker.
- Al pulsar **Crear/Generar Wave**, la extensión detiene momentáneamente la
  acción, guarda las SO seleccionadas como una OLA `planned` en milov-app y
  después continúa con Komodin.
- Si no se elige una ruta existente, el primer paquete de la OLA crea una ruta
  nueva y los siguientes paquetes de ese wave reutilizan la misma ruta.

## Requisitos en milov-app

1. Migraciones `20260826180000_extension_api_keys.sql` y
   `20260903120000_extension_wave_planning.sql`, además de
   `20260917164724_vehicle_wave_capacity.sql` y
   `20260917193220_wms_vehicle_sync.sql`, aplicadas.
2. Endpoints de enriquecimiento, opciones, capacidad y planeación desplegados.
3. Una API key generada:

   ```bash
   node --env-file=.env.local scripts/create-extension-api-key.mjs --label "Bodega Principal"
   ```

   Para revocar: `--revoke <id>`.

4. En **Rutas → Vehículos**, pulsar **Sincronizar vehículos del WMS**. La app
   reutiliza su login de Komodin y guarda capacidad en pallets, bodega y estado.
   Requiere `rutas:create` y `rutas:edit` con alcance `all`. También permite
   vehículos manuales con capacidad en cajas.

## Filtros, selección y capacidad

- **Ruta** corresponde a `delivery_route` (Zoho `ruta_entrega`); **Zona** a
  `route` (Zoho `ruta`, sector). Se corrige la presentación sin intercambiar
  claves ni modificar los datos históricos de clientes.
- El filtro de entrega usa la fecha del pedido local o, si no existe, la fecha
  de envío prevista de Zoho. **Mañana** usa el calendario local del navegador.
- **Seleccionar todo** marca únicamente filas visibles y habilitadas, también
  con teclado. Cambiar filtros desmarca las filas que quedan ocultas.
- El vehículo se puede elegir en la barra mientras se seleccionan pedidos o
  en el diálogo final. **Actualizar vehículos** recarga el catálogo.
- Para vehículos del WMS, el indicador conserva las cajas seleccionadas y
  muestra **pallets equivalentes estimados**: suma, por producto, sus cajas
  divididas entre las cajas por pallet configuradas en Komodin para esa bodega.
  Por ejemplo, 72 cajas de un producto con 144 CJ/pallet equivalen a 0.5 pallets.
  La consulta usa `POST /api/sales-order-planning/capacity` con `wave_enrich`.
- Si faltan reglas, unidades reconocidas como cajas o una bodega coincidente,
  se muestra **Cálculo incompleto**, sin porcentaje ni barra. Varios tipos de
  pallet activos para un SKU también impiden decidir la conversión.
- La estimación no calcula el acomodo físico ni el peso. Las reglas se cachean
  diez minutos; los vehículos manuales mantienen el indicador en cajas.
  Amarillo desde 90%, rojo al exceder. Es informativo: no bloquea el guardado
  por exceso, datos incompletos o ausencia de vehículo.
- Al reutilizar una ruta se usa su vehículo y se suma la carga existente
  (paquetes y SO pendientes). El cálculo se limita a esa ruta y esta wave;
  no suma otros viajes del mismo vehículo.
- El vehículo se guarda en la OLA y se hereda al crear su ruta. La auditoría
  de waves en milov-app muestra esa asignación. Las waves sin vehículo siguen
  siendo compatibles; se puede guardar sin indicador porcentual.
- La columna **Factura** ya no se agrega a la tabla de Komodin.

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
canal instalado compatible con Playwright. Incluyen filtros combinados,
selección con teclado, capacidad en cajas y pallets, reglas faltantes,
respuestas tardías, guardado sin vehículo y reemplazo de la tabla.

## Notas / limitaciones

- Filas cuya Reff no es una SO (`ASM-…`, `TO-…`) se muestran sin enriquecer.
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
