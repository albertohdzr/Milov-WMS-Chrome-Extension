# Milov — Komodin Wave Enrichment

Extensión de Chrome (Manifest V3) que enriquece la tabla **Crear Wave**
(`https://milov-wms.komodin.io/wave_new/`) del WMS Komodin con datos de
milov-app: ruta/zona del cliente, tipo de pedido, fecha de entrega, factura,
chofer planificado, cantidades por temperatura (seco / frío-congelado) y notas.
Agrega además una barra de filtros (Ruta, Zona, Chofer, Tipo Pedido, búsqueda) y
un resumen de cajas de las salidas seleccionadas. Antes de crear el wave pide
la fecha de salida y el chofer; opcionalmente permite reutilizar una ruta
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
   `20260903120000_extension_wave_planning.sql` aplicadas.
2. Endpoint `app/api/sales-order-planning/enrich` desplegado.
3. Una API key generada:

   ```bash
   node --env-file=.env.local scripts/create-extension-api-key.mjs --label "Bodega Principal"
   ```

   Para revocar: `--revoke <id>`.

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

## Notas / limitaciones

- Filas cuya Reff no es una SO (`ASM-…`, `TO-…`) se muestran sin enriquecer.
- El badge rojo **Difiere** aparece cuando la SO está en una OLA planificada
  para una fecha distinta a la fecha de entrega pedida.
- Si Komodin cambia el HTML de la tabla (encabezado "Reff"), hay que ajustar
  `content.js`.
- La API key requiere los scopes `wave_enrich` y `wave_plan`. La migración de
  planeación agrega `wave_plan` a las claves activas que ya tengan
  `wave_enrich`.
- Para subir a chrome store:
  ```bash
  zip -r milov-komodin-extension.zip . -x ".git/*" -x ".DS_Store"
  ```

# Milov-WMS-Chrome-Extension
