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
    val chrome=org.json.JSONArray()
    for(id in listOf("map-credit","map-credit-toggle","map-scale")) {
      val target=walk(activity.window.decorView).firstOrNull { it.getTag(com.facebook.react.R.id.react_test_id)==id }
      if(target!=null) { val xy=IntArray(2);target.getLocationOnScreen(xy);val rect=android.graphics.Rect();val visible=target.getGlobalVisibleRect(rect);chrome.put(JSONObject().put("id",id).put("x",xy[0]).put("y",xy[1]).put("width",target.width).put("height",target.height).put("visibleRect",rect.toShortString()).put("globalVisible",visible).put("shown",target.isShown)) }
    }
    result.put("chrome",chrome)
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
  private fun drag(v: View, dx: Float, dy: Float) {
    val start = main { val a=IntArray(2);v.getLocationOnScreen(a);Pair(a[0]+v.width/2f,a[1]+v.height/2f) }
    val down=SystemClock.uptimeMillis();event(down,MotionEvent.ACTION_DOWN,listOf(start))
    for(step in 1..32) { event(down,MotionEvent.ACTION_MOVE,listOf(start.first+dx*step/32f to start.second+dy*step/32f));SystemClock.sleep(16) }
    event(down,MotionEvent.ACTION_UP,listOf(start.first+dx to start.second+dy));SystemClock.sleep(600)
  }
  private fun waitUntil(condition: () -> Boolean): Boolean {
    val deadline=SystemClock.uptimeMillis()+15000
    while(SystemClock.uptimeMillis()<deadline) {
      if(main(condition)) { SystemClock.sleep(350);if(main(condition)) return true }
      SystemClock.sleep(100)
    }
    return false
  }
  private fun same(a: JSONObject,b: JSONObject) {
    assertEquals(a.getInt("viewIdentity"),b.getInt("viewIdentity"));assertEquals(a.getInt("mapIdentity"),b.getInt("mapIdentity"))
  }
  private fun snapValue(): Int {
    val handle=walk(activity.window.decorView).first { it.getTag(com.facebook.react.R.id.react_test_id)=="explore-panel-handle" }
    return (handle.getTag(com.facebook.react.R.id.accessibility_value) as com.facebook.react.bridge.ReadableMap).getDouble("now").toInt()
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
          val handled=original.dispatchTouchEvent(event)
          val detector=walk(activity.window.decorView).filterIsInstance<MLRNMapView>().firstOrNull()?.mapLibreMap?.gesturesManager?.standardScaleGestureDetector
          if(detector!=null && event.pointerCount>1) Log.i("CanvasMapScale", "pointers=${detector.pointersCount} span=${detector.currentSpan} threshold=${detector.spanSinceStartThreshold} enabled=${detector.isEnabled} progress=${detector.isInProgress}")
          return handled
        }
      }
    }
    val initial=record("initial")
    val down=SystemClock.uptimeMillis()
    event(down,MotionEvent.ACTION_DOWN,listOf(350f to 750f))
    for(i in 1..24) { event(down,MotionEvent.ACTION_MOVE,listOf((350f+i*10f) to 750f));SystemClock.sleep(16) }
    event(down,MotionEvent.ACTION_UP,listOf(590f to 750f));SystemClock.sleep(1200)
    val pan=record("pan");same(initial,pan);assertTrue(kotlin.math.abs(initial.getDouble("longitude")-pan.getDouble("longitude"))>0.0001)
    val fastPinch=InstrumentationRegistry.getArguments().getString("fastPinch")=="true"
    val spanStart=if(fastPinch) 80f else 40f
    val spanStep=if(fastPinch) 12f else 5f
    val spanEnd=spanStart+24*spanStep
    val pinchTime=SystemClock.uptimeMillis();event(pinchTime,MotionEvent.ACTION_DOWN,listOf((500f-spanStart) to 750f));event(pinchTime,MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),listOf((500f-spanStart) to 750f,(500f+spanStart) to 750f))
    for(i in 1..24) { val span=spanStart+i*spanStep;event(pinchTime,MotionEvent.ACTION_MOVE,listOf((500f-span) to 750f,(500f+span) to 750f));SystemClock.sleep(16) }
    event(pinchTime,MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),listOf((500f-spanEnd) to 750f,(500f+spanEnd) to 750f));event(pinchTime,MotionEvent.ACTION_UP,listOf((500f-spanEnd) to 750f));SystemClock.sleep(1200)
    val pinch=record("pinch");same(initial,pinch);val pinchPassed=pinch.getDouble("zoom")>pan.getDouble("zoom")+0.5;Log.i("CanvasMapProbe", JSONObject().put("step","pinch-result").put("passed",pinchPassed).toString())
    if (InstrumentationRegistry.getArguments().getString("mapOnly")=="true") { assertTrue("map-only pinch",pinchPassed);return }
    val outcomes=mutableListOf<Boolean>()
    for ((index,expected) in listOf(2,0,1).withIndex()) {
      tap(tagged("explore-panel-handle"))
      val settled=waitUntil {
        val value=walk(activity.window.decorView).first { it.getTag(com.facebook.react.R.id.react_test_id)=="explore-panel-handle" }.getTag(com.facebook.react.R.id.accessibility_value) as? com.facebook.react.bridge.ReadableMap
        value?.getDouble("now")?.toInt()==expected
      }
      outcomes.add(settled)
      val state=record("detent-$index");same(initial,state)
      assertEquals(pinch.getDouble("zoom"),state.getDouble("zoom"),0.00001)
      Log.i("CanvasMapProbe",JSONObject().put("step","detent-result-$index").put("expected",expected).put("settled",settled).toString())
    }
    drag(tagged("explore-panel-handle"),0f,-600f)
    val expandedByDrag=waitUntil { snapValue()==2 }
    assertTrue("handle drag expands panel",expandedByDrag)
    val expanded=record("handle-drag-expanded");same(initial,expanded)
    assertEquals("handle drag does not move map",pinch.getDouble("zoom"),expanded.getDouble("zoom"),0.00001)
    drag(tagged("explore-panel-handle"),0f,600f)
    val returnedByDrag=waitUntil { snapValue()==1 }
    assertTrue("handle drag returns panel to half",returnedByDrag)
    val returned=record("handle-drag-half");same(initial,returned)
    assertEquals("returning panel does not move map",pinch.getDouble("zoom"),returned.getDouble("zoom"),0.00001)
    tap(tagged("explore-search"))
    val opened=waitUntil { activity.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime())==true }
    val ime=record("ime");same(initial,ime)
    if(opened) instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
    val closed=opened && waitUntil { activity.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime())==false }
    val back=record("back");same(initial,back)
    assertEquals(pinch.getDouble("zoom"),back.getDouble("zoom"),0.00001)
    Log.i("CanvasMapProbe",JSONObject().put("step","matrix-results").put("detents",org.json.JSONArray(outcomes)).put("imeOpened",opened).put("imeClosed",closed).toString())
    assertTrue("detents settled",outcomes.all { it })
    assertTrue("IME opened",opened);assertTrue("IME closed",closed)
    assertTrue("pinch changed zoom; independent detent/IME/Back records precede this assertion",pinchPassed)
    instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
    val backClosesPanel=waitUntil { snapValue()==0 }
    val panelBack=record("panel-back")
    same(initial,panelBack)
    assertTrue("Back closes panel to peek",backClosesPanel)
    tap(tagged("explore-panel-handle"))
    assertTrue("panel reopens to half",waitUntil { snapValue()==1 })
    // Exercise the real Explore search list inside the panel, not only its handle.
    tap(tagged("explore-search"))
    instrumentation.uiAutomation.executeShellCommand("input text Paris").use { descriptor ->
      android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).readBytes()
    }
    instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
    val scrollView=walk(activity.window.decorView).first { it.getTag(com.facebook.react.R.id.react_test_id)=="explore-panel-scroll" }
    val scrollReady=waitUntil { scrollView.canScrollVertically(1) }
    assertTrue("Explore results provide scrollable panel content",scrollReady)
    val beforeScroll=main { scrollView.scrollY }
    val scrollPoint=main { val a=IntArray(2);scrollView.getLocationOnScreen(a);Pair(a[0]+scrollView.width/2f,a[1]+scrollView.height*0.78f) }
    val scrollDown=SystemClock.uptimeMillis();event(scrollDown,MotionEvent.ACTION_DOWN,listOf(scrollPoint));
    for(i in 1..24) { event(scrollDown,MotionEvent.ACTION_MOVE,listOf(scrollPoint.first to (scrollPoint.second-20f*i)));SystemClock.sleep(16) }
    event(scrollDown,MotionEvent.ACTION_UP,listOf(scrollPoint.first to (scrollPoint.second-480f)));SystemClock.sleep(1000)
    val afterScroll=main { scrollView.scrollY }
    val afterScrollSnap=snapValue()
    Log.i("CanvasMapProbe",JSONObject().put("step","body-scroll-result").put("before",beforeScroll).put("after",afterScroll).put("snap",afterScrollSnap).toString())
    assertTrue("body scroll advances while panel stays at half",afterScroll>beforeScroll && afterScrollSnap==1)
  }
  @Test fun legalTargets() {
    val intent=instrumentation.targetContext.packageManager.getLaunchIntentForPackage("to.goway.canvas663")!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    activity=instrumentation.startActivitySync(intent)
    assertTrue("map ready",waitUntil { walk(activity.window.decorView).filterIsInstance<MLRNMapView>().any { it.mapLibreMap?.style?.isFullyLoaded==true } })
    SystemClock.sleep(5500)
    val requested=InstrumentationRegistry.getArguments().getString("legalSnap")?.toInt() ?: 1
    fun currentSnap(): Int = main {
      val handle=walk(activity.window.decorView).first { it.getTag(com.facebook.react.R.id.react_test_id)=="explore-panel-handle" }
      (handle.getTag(com.facebook.react.R.id.accessibility_value) as com.facebook.react.bridge.ReadableMap).getDouble("now").toInt()
    }
    repeat(3) { if(currentSnap()!=requested) tap(tagged("explore-panel-handle")) }
    assertEquals("requested detent",requested,currentSnap())
    if(InstrumentationRegistry.getArguments().getString("legalIme")=="true") {
      tap(tagged("explore-search"))
      assertTrue("IME opened",waitUntil { activity.window.decorView.rootWindowInsets?.isVisible(android.view.WindowInsets.Type.ime())==true })
    }
    record("legal-start-$requested")
    val uris=java.util.concurrent.CopyOnWriteArrayList<String>()
    val monitor=object: android.app.Instrumentation.ActivityMonitor() {
      override fun onStartActivity(intent: Intent): android.app.Instrumentation.ActivityResult? {
        if(intent.action==Intent.ACTION_VIEW && intent.data?.scheme in listOf("https","http")) {
          uris.add(intent.data.toString())
          return android.app.Instrumentation.ActivityResult(Activity.RESULT_CANCELED,null)
        }
        return null
      }
    }
    instrumentation.addMonitor(monitor)
    val results=mutableListOf<Boolean>()
    fun links(): List<View> = main { walk(activity.window.decorView).filter { it.isAttachedToWindow && it.isShown && it.contentDescription?.toString()?.let { text -> text.contains("OpenMapTiles") || text.contains("OpenStreetMap") || text.contains("Mapterhorn") }==true } }
    fun point(v: View,edge: String): Pair<Float,Float> = main {
      val xy=IntArray(2);v.getLocationOnScreen(xy)
      val halfTarget=24f*activity.resources.displayMetrics.density
      Pair(if(edge=="left") xy[0]+1f else if(edge=="right") xy[0]+v.width-1f else xy[0]+v.width/2f,xy[1]+v.height/2f+if(edge=="top") -halfTarget+1f else if(edge=="bottom") halfTarget-1f else 0f)
    }
    fun press(v: View,edge: String): Pair<Float,Float> {
      val xy=point(v,edge);val t=SystemClock.uptimeMillis()
      event(t,MotionEvent.ACTION_DOWN,listOf(xy));SystemClock.sleep(70);event(t,MotionEvent.ACTION_UP,listOf(xy));SystemClock.sleep(1000)
      return xy
    }
    fun geometry(v: View): org.json.JSONArray = main {
      val result=org.json.JSONArray();var current: View?=v
      while(current!=null) {
        val item=current;val xy=IntArray(2);item.getLocationOnScreen(xy)
        val rect=android.graphics.Rect();item.getGlobalVisibleRect(rect)
        result.put(JSONObject().put("class",item.javaClass.simpleName).put("x",xy[0]).put("y",xy[1]).put("width",item.width).put("height",item.height).put("visibleRect",rect.toShortString()).put("clipChildren",(item as? ViewGroup)?.clipChildren))
        current=item.parent as? View
      };result
    }
    try {
      for(edge in listOf("center","top","bottom","left","right")) {
        if(links().isNotEmpty()) tap(tagged("map-credit-toggle"))
        val toggle=tagged("map-credit-toggle");val bounds=geometry(toggle);val xy=press(toggle,edge)
        results.add(links().isNotEmpty())
        Log.i("CanvasLegal",JSONObject().put("kind","toggle").put("edge",edge).put("x",xy.first).put("y",xy.second).put("ancestors",bounds).put("opened",links().isNotEmpty()).toString())
      }
      if(links().isEmpty()) tap(tagged("map-credit-toggle"))
      val labels=links().map { main { it.contentDescription.toString() } }.distinct()
      assertTrue("expanded links",labels.size>=3)
      for(label in labels) for(edge in listOf("center","top","bottom","left","right")) {
        if(links().isEmpty()) tap(tagged("map-credit-toggle"))
        assertTrue("live link $label",waitUntil { walk(activity.window.decorView).any { it.contentDescription?.toString()==label && it.isAttachedToWindow && it.isShown } })
        val link=links().first { main { it.contentDescription.toString()==label } }
        val before=uris.size;val bounds=geometry(link);val xy=press(link,edge)
        results.add(uris.size>before)
        Log.i("CanvasLegal",JSONObject().put("kind","link").put("label",label).put("edge",edge).put("x",xy.first).put("y",xy.second).put("ancestors",bounds).put("activated",uris.size>before).put("destinations",org.json.JSONArray(uris.drop(before))).toString())
      }
      record("legal-expanded")
      assertTrue("every live target sample activates",results.all { it })
    } finally {instrumentation.removeMonitor(monitor)}
  }
}
