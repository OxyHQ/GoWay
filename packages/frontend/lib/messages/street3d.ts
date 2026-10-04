/**
 * Street 3D and contribution-status strings, per locale.
 *
 * Kept beside `lib/i18n.tsx` rather than inside it because there are many of
 * them and they are a feature's, not the map's. `__tests__/messages.test.ts`
 * asserts every locale carries every key, so a new string cannot ship
 * half-translated.
 *
 * Copy rules (issue #15): say what is true now, explain it plainly, and never
 * imply that a PUBLISHED scene will disappear — expiry is always about the
 * temporary source media.
 */

export const STREET3D_EN: Record<string, string> = {
  // Capture guide
  'contribute.guide.title': 'How to capture a street',
  'contribute.guide.why': 'A street becomes a good 3D view when it is seen from many positions and directions. Several people capturing the same street on different days is better than one perfect pass.',
  'contribute.guide.phone.title': 'With your phone (works today)',
  'contribute.guide.phone.landscape': 'Record 4K video holding the phone in landscape, at chest height and steady.',
  'contribute.guide.phone.slow': 'Walk slowly, about 3 km/h, without sudden turns.',
  'contribute.guide.phone.sides': 'Cover each stretch twice: once looking along the street, once facing each side of it, from both pavements.',
  'contribute.guide.phone.people': 'Prefer quieter times. Faces and number plates are blurred automatically, and people and vehicles are left out of the 3D view.',
  'contribute.guide.camera.title': 'With a 360° camera (recommended for mapping)',
  'contribute.guide.camera.soon': '360° uploads are coming soon.',
  'contribute.guide.camera.recommendation': 'An affordable option is a GoPro MAX (first generation, often available second-hand): it records 360° photos with built-in GPS. A 360° camera sees both sides of the street at once, which makes much better 3D views.',
  'contribute.guide.camera.mount': 'Mount it on a pole or helmet about 30–50 cm above your head.',
  'contribute.guide.camera.interval': 'Use interval photo mode, one photo every 1–2 metres, with GPS on.',
  'contribute.guide.camera.walk': 'Walk at 3–4 km/h along both pavements; bright, overcast days work best.',
  'contribute.guide.camera.repeat': 'Coming back on another day helps: new captures are combined with earlier ones automatically.',
  'contribute.guide.privacy': 'Only capture public streets from public places. Do not film into homes or private spaces.',
  // Map layer
  'street3d.layer.open': 'Open Street 3D view',
  'street3d.layer.approximate': 'approximate placement',
  'street3d.layer.contributeHint': 'More photos here could complete a Street 3D view.',
  'street3d.contribute.cta': 'Contribute here',

  // Viewer
  'street3d.viewer.close': 'Back to map',
  'street3d.viewer.report': 'Report',
  'street3d.viewer.loading': 'Loading 3D view…',
  'street3d.viewer.unsupported': "This device can't display 3D views. The map works as usual.",
  'street3d.viewer.error': "This 3D view couldn't be loaded.",
  'street3d.viewer.notFound': "This 3D view isn't available.",
  'street3d.viewer.retry': 'Try again',
  'street3d.viewer.approximate': 'Approximate placement: this view may be offset from the map.',
  'street3d.viewer.observed': 'Imagery from {from} to {to}',
  'street3d.viewer.observedSame': 'Imagery from {date}',
  'street3d.viewer.controls.orbit': 'Orbit',
  'street3d.viewer.controls.walk': 'Walk',
  'street3d.viewer.controls.hint': 'Drag to look · WASD or arrows to move · scroll or pinch to zoom',
  'street3d.viewer.controls.hintGuided': 'Drag to look · W/S, arrows or click ahead to walk · A/D to turn',
  'street3d.viewer.stepForward': 'Step forward',
  'street3d.viewer.stepBack': 'Step back',
  'street3d.viewer.stepHere': 'Go here',

  // Report
  'street3d.report.title': 'Report this 3D view',
  'street3d.report.reason.privacy': 'Privacy: a face, plate or private space is visible',
  'street3d.report.reason.inappropriate': 'Inappropriate content',
  'street3d.report.reason.inaccurate': 'Inaccurate or misplaced',
  'street3d.report.reason.other': 'Something else',
  'street3d.report.note': 'Details (optional, never published)',
  'street3d.report.submit': 'Send report',
  'street3d.report.cancel': 'Cancel',
  'street3d.report.done': 'Done',
  'street3d.report.sent': 'Thank you. Your report was sent for review.',
  'street3d.report.failed': "The report couldn't be sent. Please try again.",
  'street3d.report.signIn': 'Sign in to send a report.',

  // Contribution status (#15)
  'contribute.kind.photo': 'Photo',
  'contribute.kind.video': 'Video',
  'contribute.withdraw': 'Withdraw contribution',
  'contribute.status.expected.title': 'Waiting for upload',
  'contribute.status.expected.body': "The upload hasn't arrived yet. Retry to resume it.",
  'contribute.status.abandoned.title': 'Upload expired',
  'contribute.status.abandoned.body': 'The upload was never completed, so nothing was kept.',
  'contribute.status.checking.title': 'Checking media',
  'contribute.status.checking.body': 'GoWay is checking the file before privacy processing.',
  'contribute.status.privacyPending.title': 'Privacy processing pending',
  'contribute.status.privacyPending.body':
    'Before anything else, faces and licence plates are blurred. This runs on an external worker and can take a while.',
  'contribute.status.privacyProcessing.title': 'Privacy processing',
  'contribute.status.privacyProcessing.body': 'Faces and licence plates are being blurred now.',
  'contribute.status.privacyFailed.title': 'Privacy check failed',
  'contribute.status.privacyFailed.body':
    "The privacy check couldn't clear this media, so it won't be used. Nothing from it was published.",
  'contribute.status.blocked.title': 'Removed by moderation',
  'contribute.status.blocked.body': "This media won't be used.",
  'contribute.status.accepted.title': 'Privacy check passed',
  'contribute.status.accepted.body': 'Waiting to be matched with nearby views.',
  'contribute.status.rejected.title': 'Not usable',
  'contribute.status.rejected.body': "This file couldn't be used, so it won't be part of a 3D view.",
  'contribute.status.waitingForOverlap.title': 'Waiting for complementary views',
  'contribute.status.waitingForOverlap.body':
    'A 3D view needs several overlapping photos of the same spot from different angles. Yours is kept until it expires in case others arrive.',
  'contribute.status.reconstructionCandidate.title': 'Selected for reconstruction',
  'contribute.status.reconstructionCandidate.body':
    "There's enough overlap here. It's queued for reconstruction, which can take days. Not every reconstruction is published.",
  'contribute.status.integrated.title': 'Helped build a 3D view',
  'contribute.status.integrated.body':
    'Your contribution was used in a reconstruction. A published 3D view stays available after the original media expires.',
  'contribute.status.expired.title': 'Temporary source expired',
  'contribute.status.expired.body':
    'The original media reached the end of its retention period and was deleted. Anything already published is unaffected.',
  'contribute.status.deleted.title': 'Contribution withdrawn',
  'contribute.status.deleted.body':
    'Removed from future use. Temporary files are queued for cleanup when no other contribution needs them.',
  'contribute.status.privacyPassedLine': 'Privacy check passed.',
  'contribute.status.expires': 'Temporary source expected to expire around {date}.',
  'contribute.status.protected': 'Kept until {date} because it may help complete a 3D view nearby.',
  'contribute.status.atRisk': 'Area at risk — more photos here could complete it.',
  'contribute.status.atRiskUntil': 'Area at risk — more photos here before {date} could complete it.',
};

export const STREET3D_ES: Record<string, string> = {
  // Capture guide
  'contribute.guide.title': 'Cómo capturar una calle',
  'contribute.guide.why': 'Una calle se convierte en una buena vista 3D cuando se ve desde muchas posiciones y direcciones. Varias personas capturando la misma calle en días distintos es mejor que una sola pasada perfecta.',
  'contribute.guide.phone.title': 'Con tu móvil (funciona hoy)',
  'contribute.guide.phone.landscape': 'Graba vídeo 4K con el móvil en horizontal, a la altura del pecho y estable.',
  'contribute.guide.phone.slow': 'Camina despacio, a unos 3 km/h, sin giros bruscos.',
  'contribute.guide.phone.sides': 'Cubre cada tramo dos veces: una mirando a lo largo de la calle y otra mirando a cada lado, desde ambas aceras.',
  'contribute.guide.phone.people': 'Mejor en horas tranquilas. Las caras y matrículas se difuminan automáticamente y las personas y vehículos se excluyen de la vista 3D.',
  'contribute.guide.camera.title': 'Con una cámara 360° (recomendada para mapear)',
  'contribute.guide.camera.soon': 'La subida de 360° llegará pronto.',
  'contribute.guide.camera.recommendation': 'Una opción asequible es una GoPro MAX (primera generación, fácil de encontrar de segunda mano): hace fotos 360° con GPS integrado. Una cámara 360° ve ambos lados de la calle a la vez, lo que da vistas 3D mucho mejores.',
  'contribute.guide.camera.mount': 'Móntala en un palo o casco unos 30–50 cm por encima de tu cabeza.',
  'contribute.guide.camera.interval': 'Usa el modo foto por intervalos, una foto cada 1–2 metros, con el GPS activado.',
  'contribute.guide.camera.walk': 'Camina a 3–4 km/h por ambas aceras; los días claros pero nublados son los mejores.',
  'contribute.guide.camera.repeat': 'Volver otro día ayuda: las nuevas capturas se combinan con las anteriores automáticamente.',
  'contribute.guide.privacy': 'Captura solo calles públicas desde lugares públicos. No grabes el interior de viviendas ni espacios privados.',
  'street3d.layer.open': 'Abrir vista Street 3D',
  'street3d.layer.approximate': 'ubicación aproximada',
  'street3d.layer.contributeHint': 'Más fotos aquí podrían completar una vista Street 3D.',
  'street3d.contribute.cta': 'Contribuir aquí',

  'street3d.viewer.close': 'Volver al mapa',
  'street3d.viewer.report': 'Denunciar',
  'street3d.viewer.loading': 'Cargando vista 3D…',
  'street3d.viewer.unsupported': 'Este dispositivo no puede mostrar vistas 3D. El mapa funciona como siempre.',
  'street3d.viewer.error': 'No se pudo cargar esta vista 3D.',
  'street3d.viewer.notFound': 'Esta vista 3D no está disponible.',
  'street3d.viewer.retry': 'Reintentar',
  'street3d.viewer.approximate': 'Ubicación aproximada: esta vista puede estar desplazada respecto al mapa.',
  'street3d.viewer.observed': 'Imágenes de {from} a {to}',
  'street3d.viewer.observedSame': 'Imágenes de {date}',
  'street3d.viewer.controls.orbit': 'Orbitar',
  'street3d.viewer.controls.walk': 'Caminar',
  'street3d.viewer.controls.hint': 'Arrastra para mirar · WASD o flechas para moverte · rueda o pellizco para acercar',
  'street3d.viewer.controls.hintGuided': 'Arrastra para mirar · W/S, flechas o clic delante para caminar · A/D para girar',
  'street3d.viewer.stepForward': 'Avanzar',
  'street3d.viewer.stepBack': 'Retroceder',
  'street3d.viewer.stepHere': 'Ir aquí',

  'street3d.report.title': 'Denunciar esta vista 3D',
  'street3d.report.reason.privacy': 'Privacidad: se ve una cara, una matrícula o un espacio privado',
  'street3d.report.reason.inappropriate': 'Contenido inapropiado',
  'street3d.report.reason.inaccurate': 'Inexacta o mal ubicada',
  'street3d.report.reason.other': 'Otro motivo',
  'street3d.report.note': 'Detalles (opcional, nunca se publican)',
  'street3d.report.submit': 'Enviar denuncia',
  'street3d.report.cancel': 'Cancelar',
  'street3d.report.done': 'Listo',
  'street3d.report.sent': 'Gracias. Tu denuncia se ha enviado para revisión.',
  'street3d.report.failed': 'No se pudo enviar la denuncia. Inténtalo de nuevo.',
  'street3d.report.signIn': 'Inicia sesión para enviar una denuncia.',

  'contribute.kind.photo': 'Foto',
  'contribute.kind.video': 'Vídeo',
  'contribute.withdraw': 'Retirar contribución',
  'contribute.status.expected.title': 'Esperando la subida',
  'contribute.status.expected.body': 'La subida aún no ha llegado. Reintenta para reanudarla.',
  'contribute.status.abandoned.title': 'Subida caducada',
  'contribute.status.abandoned.body': 'La subida no se completó, así que no se guardó nada.',
  'contribute.status.checking.title': 'Comprobando el archivo',
  'contribute.status.checking.body': 'GoWay está comprobando el archivo antes del procesamiento de privacidad.',
  'contribute.status.privacyPending.title': 'Procesamiento de privacidad pendiente',
  'contribute.status.privacyPending.body':
    'Antes que nada, se difuminan caras y matrículas. Esto se ejecuta en un procesador externo y puede tardar.',
  'contribute.status.privacyProcessing.title': 'Procesando privacidad',
  'contribute.status.privacyProcessing.body': 'Se están difuminando caras y matrículas.',
  'contribute.status.privacyFailed.title': 'La comprobación de privacidad falló',
  'contribute.status.privacyFailed.body':
    'La comprobación de privacidad no pudo validar este archivo, así que no se usará. No se ha publicado nada de él.',
  'contribute.status.blocked.title': 'Retirado por moderación',
  'contribute.status.blocked.body': 'Este archivo no se usará.',
  'contribute.status.accepted.title': 'Privacidad comprobada',
  'contribute.status.accepted.body': 'Esperando a combinarse con vistas cercanas.',
  'contribute.status.rejected.title': 'No utilizable',
  'contribute.status.rejected.body': 'Este archivo no se pudo usar, así que no formará parte de una vista 3D.',
  'contribute.status.waitingForOverlap.title': 'Esperando vistas complementarias',
  'contribute.status.waitingForOverlap.body':
    'Una vista 3D necesita varias fotos solapadas del mismo lugar desde distintos ángulos. La tuya se guarda hasta que caduque por si llegan otras.',
  'contribute.status.reconstructionCandidate.title': 'Seleccionada para reconstrucción',
  'contribute.status.reconstructionCandidate.body':
    'Aquí hay suficiente solapamiento. Está en cola para la reconstrucción, que puede tardar días. No todas las reconstrucciones se publican.',
  'contribute.status.integrated.title': 'Ayudó a crear una vista 3D',
  'contribute.status.integrated.body':
    'Tu contribución se usó en una reconstrucción. Una vista 3D publicada sigue disponible aunque caduque el archivo original.',
  'contribute.status.expired.title': 'Archivo temporal caducado',
  'contribute.status.expired.body':
    'El archivo original llegó al final de su periodo de conservación y se eliminó. Lo que ya está publicado no se ve afectado.',
  'contribute.status.deleted.title': 'Contribución retirada',
  'contribute.status.deleted.body':
    'Ya no se usará. Los archivos temporales se eliminarán cuando ninguna otra contribución los necesite.',
  'contribute.status.privacyPassedLine': 'Comprobación de privacidad superada.',
  'contribute.status.expires': 'Se espera que el archivo temporal caduque hacia el {date}.',
  'contribute.status.protected': 'Se conserva hasta el {date} porque puede ayudar a completar una vista 3D cercana.',
  'contribute.status.atRisk': 'Zona en riesgo: más fotos aquí podrían completarla.',
  'contribute.status.atRiskUntil': 'Zona en riesgo: más fotos aquí antes del {date} podrían completarla.',
};
