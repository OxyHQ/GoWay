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
    Log.i("CanvasMapProbe", result.toString())
    result
  }
  private fun event(down: Long, action: Int, points: List<Pair<Float,Float>>) {
    val properties = points.mapIndexed { index, _ -> MotionEvent.PointerProperties().apply { id=index; toolType=MotionEvent.TOOL_TYPE_FINGER } }.toTypedArray()
    val coordinates = points.map { MotionEvent.PointerCoords().apply { x=it.first; y=it.second; pressure=1f; size=1f } }.toTypedArray()
    val e = MotionEvent.obtain(down,SystemClock.uptimeMillis(),action,points.size,properties,coordinates,0,0,1f,1f,0,0,InputDevice.SOURCE_TOUCHSCREEN,0)
    assertTrue("system accepted touch", instrumentation.uiAutomation.injectInputEvent(e, false)); e.recycle()
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
    val initial=record("initial")
    val down=SystemClock.uptimeMillis()
    event(down,MotionEvent.ACTION_DOWN,listOf(350f to 750f))
    for(i in 1..24) { event(down,MotionEvent.ACTION_MOVE,listOf((350f+i*10f) to 750f));SystemClock.sleep(16) }
    event(down,MotionEvent.ACTION_UP,listOf(590f to 750f));SystemClock.sleep(1200)
    val pan=record("pan");same(initial,pan);assertTrue(kotlin.math.abs(initial.getDouble("longitude")-pan.getDouble("longitude"))>0.0001)
    val pinchTime=SystemClock.uptimeMillis();event(pinchTime,MotionEvent.ACTION_DOWN,listOf(460f to 750f));event(pinchTime,MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),listOf(460f to 750f,540f to 750f))
    for(i in 1..24) { val span=40f+i*5f;event(pinchTime,MotionEvent.ACTION_MOVE,listOf((500f-span) to 750f,(500f+span) to 750f));SystemClock.sleep(16) }
    event(pinchTime,MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),listOf(340f to 750f,660f to 750f));event(pinchTime,MotionEvent.ACTION_UP,listOf(340f to 750f));SystemClock.sleep(1200)
    val pinch=record("pinch");same(initial,pinch);assertTrue(pinch.getDouble("zoom")>pan.getDouble("zoom")+0.5)
    repeat(3) { index -> tap(tagged("explore-panel-handle"));val state=record("detent-$index");same(initial,state);assertEquals(pinch.getDouble("zoom"),state.getDouble("zoom"),0.00001) }
    tap(tagged("explore-search"));SystemClock.sleep(1000);val ime=record("ime");same(initial,ime)
    instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);SystemClock.sleep(1000);val back=record("back");same(initial,back);assertEquals(pinch.getDouble("zoom"),back.getDouble("zoom"),0.00001)
  }
}
