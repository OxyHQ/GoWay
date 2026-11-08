package to.goway.canvas663

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.maplibre.reactnative.components.mapview.MLRNMapView
import org.maplibre.android.style.layers.HillshadeLayer

@RunWith(AndroidJUnit4::class)
class CanvasMapProbeTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private lateinit var activity: Activity
  private fun walk(v: View): List<View> = listOf(v) + if (v is ViewGroup) (0 until v.childCount).flatMap { walk(v.getChildAt(it)) } else emptyList()
  private fun <T> main(block: () -> T): T {
    var result: T? = null
    instrumentation.runOnMainSync { result = block() }
    @Suppress("UNCHECKED_CAST") return result as T
  }
  private fun map(): MLRNMapView = main { walk(activity.window.decorView).filterIsInstance<MLRNMapView>().single() }
  private fun tagged(id: String): View = main { walk(activity.window.decorView).first { it.getTag(com.facebook.react.R.id.react_test_id) == id } }
  private fun record(name: String): JSONObject = main {
    val v = walk(activity.window.decorView).filterIsInstance<MLRNMapView>().single()
    val m = v.mapLibreMap!!
    val camera = m.cameraPosition
    val result = JSONObject().put("step", name).put("viewIdentity", System.identityHashCode(v)).put("mapIdentity", System.identityHashCode(m))
      .put("latitude", camera.target!!.latitude).put("longitude", camera.target!!.longitude).put("zoom", camera.zoom)
      .put("zoomGesturesEnabled",m.uiSettings.isZoomGesturesEnabled).put("width", v.width).put("height", v.height)
    val layers = m.style!!.layers.filterIsInstance<HillshadeLayer>()
    result.put("hillshade", org.json.JSONArray(layers.map { layer -> JSONObject().put("id",layer.id).put("shadow",org.json.JSONArray(layer.hillshadeShadowColor.value?.toList() ?: emptyList<String>())).put("highlight",org.json.JSONArray(layer.hillshadeHighlightColor.value?.toList() ?: emptyList<String>())) }))
    val handle=walk(activity.window.decorView).firstOrNull { it.getTag(com.facebook.react.R.id.react_test_id)=="explore-panel-handle" }
    if(handle!=null) { val xy=IntArray(2);handle.getLocationOnScreen(xy);result.put("handleY",xy[1]).put("handleHeight",handle.height).put("handleValue",handle.getTag(com.facebook.react.R.id.accessibility_value)?.toString()) }
    result.put("imeVisible",activity.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime())==true)
    Log.i("CanvasMapProbe", result.toString())
    instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> java.io.File(instrumentation.targetContext.getExternalFilesDir(null),"nativeprobe-$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle() }
    result
  }
  private fun event(down: Long, action: Int, points: List<Pair<Float,Float>>) {
    val properties = points.mapIndexed { index, _ -> MotionEvent.PointerProperties().apply { id=index; toolType=MotionEvent.TOOL_TYPE_FINGER } }.toTypedArray()
    val coordinates = points.map { MotionEvent.PointerCoords().apply { x=it.first; y=it.second; pressure=1f; size=1f } }.toTypedArray()
    val e = MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,points.size,properties,coordinates,0,0,1f,1f,0,0,InputDevice.SOURCE_TOUCHSCREEN,0)
    // Public two-argument API always waits for window animation fences.
    // Test-only AOSP overload keeps native system dispatch without changing device settings.
    val inject = instrumentation.uiAutomation.javaClass.getMethod("injectInputEvent", android.view.InputEvent::class.java, Boolean::class.javaPrimitiveType, Boolean::class.javaPrimitiveType)
    val started = SystemClock.uptimeMillis()
    assertTrue("system accepted touch", inject.invoke(instrumentation.uiAutomation, e, false, false) as Boolean)
    Log.i("CanvasMapInput", "action=$action pointers=${points.size} elapsedMs=${SystemClock.uptimeMillis()-started}")
    e.recycle()
  }
  private fun tap(v: View) {
    val xy = main { val a=IntArray(2);v.getLocationOnScreen(a); Pair(a[0]+v.width/2f,a[1]+v.height/2f) }
    val t=SystemClock.uptimeMillis();event(t,MotionEvent.ACTION_DOWN,listOf(xy));SystemClock.sleep(50);event(t,MotionEvent.ACTION_UP,listOf(xy));SystemClock.sleep(900)
  }
  private fun same(a: JSONObject,b: JSONObject) {
    assertEquals(a.getInt("viewIdentity"),b.getInt("viewIdentity"));assertEquals(a.getInt("mapIdentity"),b.getInt("mapIdentity"))
  }
  @Test fun realMapPanPinchDetentsAndKeyboard() {
    val intent=instrumentation.targetContext.packageManager.getLaunchIntentForPackage("to.goway.canvas663")!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    activity=instrumentation.startActivitySync(intent)
    val deadline=SystemClock.uptimeMillis()+120000
    while (SystemClock.uptimeMillis()<deadline) {
      val ready=main { walk(activity.window.decorView).filterIsInstance<MLRNMapView>().any { it.mapLibreMap?.style?.isFullyLoaded==true && (it.mapLibreMap?.cameraPosition?.zoom ?: 0.0)>2 } }
      if(ready) break
      SystemClock.sleep(250)
    }
    SystemClock.sleep(1500)
    main {
      val original=activity.window.callback
      activity.window.callback=object : android.view.Window.Callback by original {
        override fun dispatchTouchEvent(event: MotionEvent): Boolean {
          Log.i("CanvasMapInput", "delivered action=${event.actionMasked} count=${event.pointerCount} ids=${(0 until event.pointerCount).map { event.getPointerId(it) }} elapsed=${event.eventTime-event.downTime}")
          return original.dispatchTouchEvent(event)
        }
      }
    }
    val initial=record("initial")
    val down=SystemClock.uptimeMillis()
    event(down,MotionEvent.ACTION_DOWN,listOf(350f to 750f))
    for(i in 1..24) { event(down,MotionEvent.ACTION_MOVE,listOf((350f+i*10f) to 750f));SystemClock.sleep(16) }
    event(down,MotionEvent.ACTION_UP,listOf(590f to 750f));SystemClock.sleep(1200)
    val pan=record("pan");same(initial,pan);assertTrue(kotlin.math.abs(initial.getDouble("longitude")-pan.getDouble("longitude"))>0.0001)
    val pinchTime=SystemClock.uptimeMillis();event(pinchTime,MotionEvent.ACTION_DOWN,listOf(460f to 750f));event(pinchTime,MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),listOf(460f to 750f,540f to 750f))
    for(i in 1..24) { val span=40f+i*5f;event(pinchTime,MotionEvent.ACTION_MOVE,listOf((500f-span) to 750f,(500f+span) to 750f));SystemClock.sleep(16) }
    event(pinchTime,MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),listOf(340f to 750f,660f to 750f));event(pinchTime,MotionEvent.ACTION_UP,listOf(340f to 750f));SystemClock.sleep(1200)
    val pinch=record("pinch");same(initial,pinch);val pinchPassed=pinch.getDouble("zoom")>pan.getDouble("zoom")+0.5;Log.i("CanvasMapProbe", JSONObject().put("step","pinch-result").put("passed",pinchPassed).toString())
    if (InstrumentationRegistry.getArguments().getString("mapOnly")=="true") { assertTrue("map-only pinch",pinchPassed);return }
    var previousHandleY=pinch.getInt("handleY")
    repeat(3) { index -> tap(tagged("explore-panel-handle"));val state=record("detent-$index");same(initial,state);assertEquals(pinch.getDouble("zoom"),state.getDouble("zoom"),0.00001);previousHandleY=state.getInt("handleY") }
    tap(tagged("explore-search"));SystemClock.sleep(1000);val ime=record("ime");same(initial,ime);assertTrue("IME visible",ime.getBoolean("imeVisible"))
    instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);SystemClock.sleep(1000);val back=record("back");same(initial,back);assertFalse("IME dismissed",back.getBoolean("imeVisible"));assertEquals(pinch.getDouble("zoom"),back.getDouble("zoom"),0.00001)
    assertTrue("pinch changed zoom; independent detent/IME/Back records precede this assertion",pinchPassed)
  }
}
