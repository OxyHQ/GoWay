<?xml version="1.0" encoding="UTF-8"?>
<!--
  A hand-made CityGML 2.0 file for the LOD2 reader tests (`lod2Readers.test.ts`).
  Invented geometry in EPSG:25831, near Barcelona; no published dataset was copied.
  Three buildings exercise what the reader must handle:
   - "house": a gabled roof (two sloped RoofSurfaces), a GroundSurface, a WallSurface,
     generic and typed attributes, and an appearance subtree that must be skipped;
   - "tower": a Building with two BuildingParts (folded into one building);
   - "box": an lod2Solid with NO thematic surfaces, to be classified by normals.
-->
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:gen="http://www.opengis.net/citygml/generics/2.0" xmlns:app="http://www.opengis.net/citygml/appearance/2.0" xmlns:gml="http://www.opengis.net/gml">
  <gml:boundedBy>
    <gml:Envelope srsName="urn:ogc:def:crs,crs:EPSG::25831,crs:EPSG::5783" srsDimension="3">
      <gml:lowerCorner>431000 4582000 10</gml:lowerCorner>
      <gml:upperCorner>431050 4582010 40</gml:upperCorner>
    </gml:Envelope>
  </gml:boundedBy>
  <core:cityObjectMember>
    <bldg:Building gml:id="house">
      <gml:name>Test house</gml:name>
      <gen:stringAttribute name="BIN">
        <gen:value>B1</gen:value>
      </gen:stringAttribute>
      <bldg:measuredHeight uom="m">9</bldg:measuredHeight>
      <app:appearance>
        <app:Appearance>
          <app:surfaceDataMember>
            <app:ParameterizedTexture>
              <app:imageURI>roof.jpg</app:imageURI>
              <app:target uri="#roof-south">
                <app:TexCoordList>
                  <app:textureCoordinates ring="#ring">0 0 1 0 1 1 0 1 0 0</app:textureCoordinates>
                </app:TexCoordList>
              </app:target>
            </app:ParameterizedTexture>
          </app:surfaceDataMember>
        </app:Appearance>
      </app:appearance>
      <bldg:boundedBy>
        <bldg:RoofSurface gml:id="roof-south">
          <gen:stringAttribute name="BIN"><gen:value>NOT-THE-BUILDING</gen:value></gen:stringAttribute>
          <bldg:lod2MultiSurface>
            <gml:MultiSurface>
              <gml:surfaceMember>
                <gml:Polygon>
                  <gml:exterior>
                    <gml:LinearRing>
                      <gml:posList srsDimension="3">431000 4582000 16 431010 4582000 16 431010 4582004 19 431000 4582004 19 431000 4582000 16</gml:posList>
                    </gml:LinearRing>
                  </gml:exterior>
                </gml:Polygon>
              </gml:surfaceMember>
            </gml:MultiSurface>
          </bldg:lod2MultiSurface>
        </bldg:RoofSurface>
      </bldg:boundedBy>
      <bldg:boundedBy>
        <bldg:RoofSurface gml:id="roof-north">
          <bldg:lod2MultiSurface>
            <gml:MultiSurface>
              <gml:surfaceMember>
                <gml:Polygon>
                  <gml:exterior>
                    <gml:LinearRing>
                      <gml:pos>431000 4582004 19</gml:pos>
                      <gml:pos>431010 4582004 19</gml:pos>
                      <gml:pos>431010 4582008 16</gml:pos>
                      <gml:pos>431000 4582008 16</gml:pos>
                      <gml:pos>431000 4582004 19</gml:pos>
                    </gml:LinearRing>
                  </gml:exterior>
                </gml:Polygon>
              </gml:surfaceMember>
            </gml:MultiSurface>
          </bldg:lod2MultiSurface>
        </bldg:RoofSurface>
      </bldg:boundedBy>
      <bldg:boundedBy>
        <bldg:WallSurface gml:id="wall-south">
          <bldg:lod2MultiSurface>
            <gml:MultiSurface>
              <gml:surfaceMember>
                <gml:Polygon>
                  <gml:exterior>
                    <gml:LinearRing>
                      <gml:posList>431000 4582000 10 431010 4582000 10 431010 4582000 16 431000 4582000 16 431000 4582000 10</gml:posList>
                    </gml:LinearRing>
                  </gml:exterior>
                </gml:Polygon>
              </gml:surfaceMember>
            </gml:MultiSurface>
          </bldg:lod2MultiSurface>
        </bldg:WallSurface>
      </bldg:boundedBy>
      <bldg:boundedBy>
        <bldg:GroundSurface gml:id="ground">
          <bldg:lod2MultiSurface>
            <gml:MultiSurface>
              <gml:surfaceMember>
                <gml:Polygon>
                  <gml:exterior>
                    <gml:LinearRing>
                      <gml:posList>431000 4582000 10 431000 4582008 10 431010 4582008 10 431010 4582000 10 431000 4582000 10</gml:posList>
                    </gml:LinearRing>
                  </gml:exterior>
                </gml:Polygon>
              </gml:surfaceMember>
            </gml:MultiSurface>
          </bldg:lod2MultiSurface>
        </bldg:GroundSurface>
      </bldg:boundedBy>
    </bldg:Building>
  </core:cityObjectMember>
  <core:cityObjectMember>
    <bldg:Building gml:id="tower">
      <gen:stringAttribute name="BIN"><gen:value>B2</gen:value></gen:stringAttribute>
      <bldg:consistsOfBuildingPart>
        <bldg:BuildingPart gml:id="tower-podium">
          <bldg:boundedBy>
            <bldg:RoofSurface>
              <bldg:lod2MultiSurface>
                <gml:MultiSurface>
                  <gml:surfaceMember>
                    <gml:Polygon>
                      <gml:exterior>
                        <gml:LinearRing>
                          <gml:posList>431020 4582000 13 431030 4582000 13 431030 4582010 13 431020 4582010 13 431020 4582000 13</gml:posList>
                        </gml:LinearRing>
                      </gml:exterior>
                      <gml:interior>
                        <gml:LinearRing>
                          <gml:posList>431024 4582004 13 431024 4582006 13 431026 4582006 13 431026 4582004 13 431024 4582004 13</gml:posList>
                        </gml:LinearRing>
                      </gml:interior>
                    </gml:Polygon>
                  </gml:surfaceMember>
                </gml:MultiSurface>
              </bldg:lod2MultiSurface>
            </bldg:RoofSurface>
          </bldg:boundedBy>
        </bldg:BuildingPart>
      </bldg:consistsOfBuildingPart>
      <bldg:consistsOfBuildingPart>
        <bldg:BuildingPart gml:id="tower-top">
          <bldg:boundedBy>
            <bldg:RoofSurface>
              <bldg:lod2MultiSurface>
                <gml:MultiSurface>
                  <gml:surfaceMember>
                    <gml:Polygon>
                      <gml:exterior>
                        <gml:LinearRing>
                          <gml:posList>431030 4582000 40 431034 4582000 40 431034 4582004 40 431030 4582004 40 431030 4582000 40</gml:posList>
                        </gml:LinearRing>
                      </gml:exterior>
                    </gml:Polygon>
                  </gml:surfaceMember>
                </gml:MultiSurface>
              </bldg:lod2MultiSurface>
            </bldg:RoofSurface>
          </bldg:boundedBy>
          <bldg:boundedBy>
            <bldg:GroundSurface>
              <bldg:lod2MultiSurface>
                <gml:MultiSurface>
                  <gml:surfaceMember>
                    <gml:Polygon>
                      <gml:exterior>
                        <gml:LinearRing>
                          <gml:posList>431020 4582000 10 431020 4582010 10 431034 4582010 10 431034 4582000 10 431020 4582000 10</gml:posList>
                        </gml:LinearRing>
                      </gml:exterior>
                    </gml:Polygon>
                  </gml:surfaceMember>
                </gml:MultiSurface>
              </bldg:lod2MultiSurface>
            </bldg:GroundSurface>
          </bldg:boundedBy>
        </bldg:BuildingPart>
      </bldg:consistsOfBuildingPart>
    </bldg:Building>
  </core:cityObjectMember>
  <core:cityObjectMember>
    <bldg:Building gml:id="box">
      <bldg:lod2Solid>
        <gml:Solid>
          <gml:exterior>
            <gml:CompositeSurface>
              <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>431040 4582000 22 431046 4582000 22 431046 4582006 22 431040 4582006 22 431040 4582000 22</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
              <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>431040 4582000 10 431040 4582006 10 431046 4582006 10 431046 4582000 10 431040 4582000 10</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
              <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>431040 4582000 10 431046 4582000 10 431046 4582000 22 431040 4582000 22 431040 4582000 10</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember>
              <gml:surfaceMember xlink:href="#elsewhere" xmlns:xlink="http://www.w3.org/1999/xlink"/>
            </gml:CompositeSurface>
          </gml:exterior>
        </gml:Solid>
      </bldg:lod2Solid>
    </bldg:Building>
  </core:cityObjectMember>
</core:CityModel>
