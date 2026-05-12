from ckanext.geoview import plugin

def test_plugin():
    """This is here just as a sanity test
    """
    p = plugin.OLGeoView()
    assert p


def test_wcs_plugin():
    p = plugin.WCSView()
    assert p
