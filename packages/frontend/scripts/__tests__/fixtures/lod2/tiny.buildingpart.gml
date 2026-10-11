<?xml version="1.0" encoding="ISO-8859-1"?>
<!-- A hand-made INSPIRE Buildings 2D file in the Spanish Catastro's layout, for
     `lod2Cadastre.test.ts`. Invented geometry and references (EPSG:25831, near
     Barcelona); no published record was copied. One cadastral building
     "TEST001" of three parts: a 7-storey street block, a 1-storey rear wing,
     and a 0-storey patio roof; and one part whose floor count is junk. -->
<gml:FeatureCollection gml:id="ES.SDGC.BU" xmlns:base="urn:x-inspire:specification:gmlas:BaseTypes:3.2" xmlns:bu-core2d="http://inspire.jrc.ec.europa.eu/schemas/bu-core2d/2.0" xmlns:bu-ext2d="http://inspire.jrc.ec.europa.eu/schemas/bu-ext2d/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <gml:featureMember>
    <bu-ext2d:BuildingPart gml:id="ES.SDGC.BU.TEST001_part1">
      <bu-ext2d:geometry><bu-core2d:BuildingGeometry><bu-core2d:geometry>
        <gml:Surface gml:id="Surface_ES.SDGC.BU.TEST001_part1" srsName="urn:ogc:def:crs:EPSG::25831">
          <gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing>
            <gml:posList srsDimension="2" count="5">431000 4582000 431020 4582000 431020 4582012 431000 4582012 431000 4582000</gml:posList>
          </gml:LinearRing></gml:exterior><gml:interior><gml:LinearRing>
            <gml:posList srsDimension="2" count="5">431008 4582004 431008 4582006 431012 4582006 431012 4582004 431008 4582004</gml:posList>
          </gml:LinearRing></gml:interior></gml:PolygonPatch></gml:patches>
        </gml:Surface>
      </bu-core2d:geometry></bu-core2d:BuildingGeometry></bu-ext2d:geometry>
      <bu-ext2d:numberOfFloorsAboveGround>7</bu-ext2d:numberOfFloorsAboveGround>
      <bu-ext2d:numberOfFloorsBelowGround>1</bu-ext2d:numberOfFloorsBelowGround>
    </bu-ext2d:BuildingPart>
  </gml:featureMember>
  <gml:featureMember>
    <bu-ext2d:BuildingPart gml:id="ES.SDGC.BU.TEST001_part2">
      <bu-ext2d:geometry><bu-core2d:BuildingGeometry><bu-core2d:geometry>
        <gml:Surface srsName="urn:ogc:def:crs:EPSG::25831">
          <gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing>
            <gml:posList srsDimension="2" count="5">431000 4582012 431020 4582012 431020 4582020 431000 4582020 431000 4582012</gml:posList>
          </gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches>
        </gml:Surface>
      </bu-core2d:geometry></bu-core2d:BuildingGeometry></bu-ext2d:geometry>
      <bu-ext2d:numberOfFloorsAboveGround>1</bu-ext2d:numberOfFloorsAboveGround>
      <bu-ext2d:numberOfFloorsBelowGround>0</bu-ext2d:numberOfFloorsBelowGround>
    </bu-ext2d:BuildingPart>
  </gml:featureMember>
  <gml:featureMember>
    <bu-ext2d:BuildingPart gml:id="ES.SDGC.BU.TEST001_part3">
      <bu-ext2d:geometry><bu-core2d:BuildingGeometry><bu-core2d:geometry>
        <gml:Surface srsName="urn:ogc:def:crs:EPSG::25831">
          <gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing>
            <gml:posList srsDimension="2" count="5">431008 4582004 431012 4582004 431012 4582006 431008 4582006 431008 4582004</gml:posList>
          </gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches>
        </gml:Surface>
      </bu-core2d:geometry></bu-core2d:BuildingGeometry></bu-ext2d:geometry>
      <bu-ext2d:numberOfFloorsAboveGround>0</bu-ext2d:numberOfFloorsAboveGround>
    </bu-ext2d:BuildingPart>
  </gml:featureMember>
  <gml:featureMember>
    <bu-ext2d:BuildingPart gml:id="ES.SDGC.BU.TEST002_part1">
      <bu-ext2d:geometry><bu-core2d:BuildingGeometry><bu-core2d:geometry>
        <gml:Surface srsName="urn:ogc:def:crs:EPSG::25831">
          <gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing>
            <gml:posList srsDimension="2" count="5">431030 4582000 431040 4582000 431040 4582010 431030 4582010 431030 4582000</gml:posList>
          </gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches>
        </gml:Surface>
      </bu-core2d:geometry></bu-core2d:BuildingGeometry></bu-ext2d:geometry>
      <bu-ext2d:numberOfFloorsAboveGround>seven</bu-ext2d:numberOfFloorsAboveGround>
    </bu-ext2d:BuildingPart>
  </gml:featureMember>
</gml:FeatureCollection>
